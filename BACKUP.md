# dbbackup — pg_dump backup guide

This covers running `pg-dump-only.js`: a minimal PostgreSQL backup script with
**no permanent local footprint**. Each run:

1. `pg_dump`s the database twice — custom format (`.dump`) and plain SQL format (`.sql`) — into the OS temp directory
2. Verifies each dump (minimum file size, `pg_restore --list` on the custom format)
3. SHA-256 checksums each file
4. GPG-encrypts each file and `chmod 600`s it
5. Uploads the encrypted files + checksums to Supabase Storage
6. Deletes every temp file (plaintext, encrypted, checksum) — always, whether the run succeeded or failed

No WAL archiving, no state file, no local retention/rotation, no lock file. If you need
point-in-time recovery via WAL-G, that lives in a separate script — this one is only for
periodic, portable, offsite dumps.

## Requirements

System binaries on `PATH`, version-matched to the Postgres server:

- `pg_dump`
- `pg_restore`
- `gpg`

Node dependencies (already in `package.json`):

- `@supabase/supabase-js`

Install with:

```bash
npm install
```

## 1. Set up environment variables

Create a file named `.env` in the project root (same directory as `pg-dump-only.js`).
**Never commit this file** — it holds live credentials.

```bash
# Postgres connection
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your-db-password
PGDATABASE=your-db-name

# Discord webhook for success/failure alerts
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxx/xxxx

# Supabase Storage (where encrypted backups are uploaded)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_BUCKET=db_backup

# Exactly one of the two GPG options below is required:
GPG_RECIPIENT=you@example.com        # asymmetric — preferred for production
# GPG_PASSPHRASE_FILE=/path/to/pass.txt  # symmetric — fallback, e.g. local testing

# Optional
# HEALTHCHECK_URL=https://hc-ping.com/xxxx   # dead-man's-switch, pinged only on full success
# MIN_DUMP_SIZE_BYTES=1024                    # minimum sane dump size (default 1024)
```

Environment variable reference:

| Variable                                                 | Required         | Purpose                                                 |
| -------------------------------------------------------- | ---------------- | ------------------------------------------------------- |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Yes              | Postgres connection details                             |
| `DISCORD_WEBHOOK_URL`                                    | Yes              | Alerting on success/failure                             |
| `SUPABASE_URL`                                           | Yes              | Supabase project URL                                    |
| `SUPABASE_SERVICE_ROLE_KEY`                              | Yes              | Service-role key, needed for server-side storage writes |
| `SUPABASE_BUCKET`                                        | Yes              | Target Supabase Storage bucket                          |
| `GPG_RECIPIENT`                                          | One of these two | GPG key ID/email for asymmetric encryption              |
| `GPG_PASSPHRASE_FILE`                                    | One of these two | Path to a passphrase file for symmetric encryption      |
| `HEALTHCHECK_URL`                                        | No               | Pinged only after a fully successful run                |
| `MIN_DUMP_SIZE_BYTES`                                    | No               | Minimum acceptable dump size in bytes (default: `1024`) |

If both `GPG_RECIPIENT` and `GPG_PASSPHRASE_FILE` are set, `GPG_RECIPIENT` (asymmetric)
takes precedence and a warning is logged.

**Load the `.env` file** — the script reads from `process.env` directly and does not load
`.env` itself. Either export the variables in your shell/cron environment, or run with a
loader such as `dotenv`/`dotenvx`, e.g.:

```bash
npx dotenv -e .env -- node pg-dump-only.js
```

## 2. Run a backup manually

From the project root, with the environment loaded:

```bash
npx dotenv -e .env -- node pg-dump-only.js
```

On success you'll see log lines for each step and a Discord notification; no dump files
are left behind locally. On failure, the failing step is logged, a Discord alert is sent
with the error, and the process exits with a non-zero code — check the log output for the
`step` that failed.

## 3. Verify a backup succeeded

- Check the Discord channel for a "pg-dump-only: succeeded" message listing the uploaded filenames.
- Check the configured Supabase Storage bucket for the new `<db>_<timestamp>.dump.gpg`, `<db>_<timestamp>.sql.gpg`, and matching `.sha256` files.
- If `HEALTHCHECK_URL` is set, confirm the monitor shows a recent successful check-in.

## 4. Schedule it (cron)

Example: daily at 03:00, loading `.env` via `dotenvx`, logging to a file:

```cron
0 3 * * * cd /opt/dbbackup && npx dotenv -e .env -- node pg-dump-only.js >> /var/log/pg-dump.log 2>&1
```

## Restoring

See [RESTORE.md](RESTORE.md) for the full restore procedure (download, decrypt, verify checksum, `pg_restore`/`psql`).
