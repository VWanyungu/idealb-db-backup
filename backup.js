import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  (level === "error" ? console.error : console.log)(line);
}

async function runCmd(bin, args, opts = {}) {
  log("info", `exec: ${bin} ${args.join(" ")}`);
  try {
    return await execFileAsync(bin, args, {
      maxBuffer: 1024 * 1024 * 64,
      ...opts,
    });
  } catch (err) {
    throw new Error(`${bin} ${args[0] ?? ""}: ${err.message}`, { cause: err });
  }
}

// Computes the SHA-256 checksum of a file's contents and returns it as a hex string.
// Used to verify integrity of the dump file
async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
}

async function notifyDiscord(config, { title, description, level = "info" }) {
  if (!config.discordWebhookUrl) return;
  const color =
    level === "error" ? 0xd32f2f : level === "warn" ? 0xf9a825 : 0x2e7d32;
  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [
          { title, description, color, timestamp: new Date().toISOString() },
        ],
      }),
    });
    if (!res.ok) log("warn", `Discord webhook responded with ${res.status}`);
  } catch (err) {
    log("warn", `Discord webhook unreachable: ${err.message}`);
  }
}

async function uploadToSupabase(config, supabase, localPath, remotePath) {
  const data = await fs.readFile(localPath);
  const { error } = await supabase.storage
    .from(config.supabaseBucket)
    .upload(remotePath, data, {
      contentType: "application/octet-stream",
      upsert: false,
    });
  if (error)
    throw new Error(
      `Supabase upload failed for ${remotePath}: ${error.message}`,
    );
}

// Set env variables
function loadConfig(env) {
  const missing = [];

  const req = (key) => {
    const v = env[key];
    if (!v) missing.push(key);
    return v;
  };

  const config = {
    pgHost: req("PGHOST"),
    pgPort: req("PGPORT"),
    pgUser: req("PGUSER"),
    pgPassword: req("PGPASSWORD"),
    pgDatabase: req("PGDATABASE"),

    discordWebhookUrl: req("DISCORD_WEBHOOK_URL"),

    supabaseUrl: req("SUPABASE_URL"),
    supabaseServiceRoleKey: req("SUPABASE_SERVICE_ROLE_KEY"),
    supabaseBucket: req("SUPABASE_BUCKET"),

    gpgPassphraseFile: req("GPG_PASSPHRASE_FILE"),

    healthcheckUrl: env.HEALTHCHECK_URL || null,
    minDumpSizeBytes: Number(env.MIN_DUMP_SIZE_BYTES || 1024),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  - ${missing.join("\n  - ")}`,
    );
  }

  return config;
}

// GPG encryption with passphrase file
async function encryptFile(config, plainPath) {
  const encPath = `${plainPath}.gpg`;
  await runCmd("gpg", [
    "--batch",
    "--yes",
    "--passphrase-file",
    config.gpgPassphraseFile,
    "--symmetric",
    "-o",
    encPath,
    plainPath,
  ]);
  return encPath;
}

// Deletes every path in the list. Ensure no backup files are stored on the server post successful backup
async function cleanup(paths) {
  for (const p of paths) {
    try {
      await fs.unlink(p);
    } catch (err) {
      if (err.code !== "ENOENT")
        log("warn", `Failed to remove temp file ${p}: ${err.message}`);
    }
  }
}

async function runPgDumpFlow(config) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pg-dump-"));
  const baseName = `${config.pgDatabase}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const customPath = path.join(tmpDir, `${baseName}.dump`);
  const plainPath = path.join(tmpDir, `${baseName}.sql`);

  let step = "setup";
  const allTempFiles = [];

  try {
    const dumpEnv = { ...process.env, PGPASSWORD: config.pgPassword };

    step = "pg_dump (custom format)";
    await runCmd(
      "pg_dump",
      [
        "-Fc",
        "-f",
        customPath,
        "-d",
        config.pgDatabase,
        "-h",
        config.pgHost,
        "-p",
        String(config.pgPort),
        "-U",
        config.pgUser,
      ],
      { env: dumpEnv },
    );
    allTempFiles.push(customPath);

    step = "pg_dump (plain format)";
    await runCmd(
      "pg_dump",
      [
        "-Fp",
        "-f",
        plainPath,
        "-d",
        config.pgDatabase,
        "-h",
        config.pgHost,
        "-p",
        String(config.pgPort),
        "-U",
        config.pgUser,
      ],
      { env: dumpEnv },
    );
    allTempFiles.push(plainPath);

    // Ensuring file size is at least 1024 bytes to hedge against Disk full issue or empty db
    step = "verify dump sizes";
    for (const f of [customPath, plainPath]) {
      const st = await fs.stat(f);
      if (st.size < config.minDumpSizeBytes) {
        throw new Error(
          `${f} is only ${st.size} bytes (minimum ${config.minDumpSizeBytes})`,
        );
      }
    }

    // Confirms the custom file is structurally a valid pg_dump custom-format archive. Doesnt work with .sql file
    step = "pg_restore --list verification";
    await runCmd("pg_restore", ["--list", customPath]);

    // Set checksum to be used when restoring
    step = "checksum";
    const checksumPaths = [];
    for (const f of [customPath, plainPath]) {
      const digest = await sha256File(f);
      const sumPath = `${f}.sha256`;
      await fs.writeFile(sumPath, `${digest}  ${path.basename(f)}\n`, "utf8");
      checksumPaths.push(sumPath);
      allTempFiles.push(sumPath);
    }

    // Encrypt with gpg with passphrase file
    step = "encrypt";
    const encPaths = [];
    for (const f of [customPath, plainPath]) {
      const encPath = await encryptFile(config, f);
      encPaths.push(encPath);
      allTempFiles.push(encPath);
    }

    // Set read/write permissions for the files' owner only.
    // Prevents other users/processes from reading the encrypted files
    step = "chmod 600";
    const uploadFiles = [...encPaths, ...checksumPaths];
    for (const f of uploadFiles) {
      await fs.chmod(f, 0o600);
    }

    step = "upload to Supabase";
    const supabase = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
    );
    for (const f of uploadFiles) {
      await uploadToSupabase(config, supabase, f, path.basename(f));
    }

    await notifyDiscord(config, {
      title: "pg-dump-only: succeeded",
      description: `pg_dump cycle completed, verified, encrypted, and uploaded.\nFiles: ${uploadFiles.map((f) => path.basename(f)).join(", ")}`,
      level: "info",
    });
    log(
      "info",
      "pg_dump flow completed successfully. No local copies retained.",
    );
    return { failed: false };
  } catch (err) {
    log("error", `pg_dump flow failed at step "${step}": ${err.message}`);
    await notifyDiscord(config, {
      title: "pg-dump-only: FAILED",
      description: `Step: **${step}**\n\`\`\`${String(err.message).slice(0, 1500)}\`\`\``,
      level: "error",
    });
    return { failed: true, step };
  } finally {
    await cleanup(allTempFiles);
    await fs.rmdir(tmpDir).catch(() => {});
  }
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    log("error", err.message);
    process.exitCode = 1;
    return;
  }

  const result = await runPgDumpFlow(config);

  if (result.failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log("error", `Fatal error: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
