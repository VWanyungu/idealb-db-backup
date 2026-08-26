# dbbackup — pg_dump backup guide

This covers running `backup.js`: a minimal PostgreSQL backup script with
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

**Before running a backup, two things must already exist:**

1. A `.env` file with the required variables (see [Set up environment variables](#1-set-up-environment-variables))
2. The GPG passphrase file pointed to by `GPG_PASSPHRASE_FILE` — a plain text file containing the passphrase used to symmetrically encrypt each dump. Without it, `backup.js` will refuse to run (missing required env var) and, even if the path is set but the file is missing, the `gpg --passphrase-file` step will fail.

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

Create a file named `.env` in the project root (same directory as `backup.js`).
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

# GPG symmetric encryption — required
GPG_PASSPHRASE_FILE=/path/to/pass.txt

# Optional
# MIN_DUMP_SIZE_BYTES=1024                    # minimum sane dump size (default 1024)
```

**Load the `.env` file** — the script reads from `process.env` directly and does not load
`.env` itself. Export the variables in your shell/cron environment before running, e.g.:

```bash
export $(cat .env | xargs)
```

## 2. Run a backup manually

From the project root, with the environment loaded:

```bash
export $(cat .env | xargs)
npm run backup
```

On success you'll see log lines for each step and a Discord notification; no dump files
are left behind locally. On failure, the failing step is logged, a Discord alert is sent
with the error, and the process exits with a non-zero code — check the log output for the
`step` that failed.

## 3. Verify a backup succeeded

- Check the Discord channel for a "pg-dump-only: succeeded" message listing the uploaded filenames.
- Check the configured Supabase Storage bucket for the new `<db>_<timestamp>.dump.gpg`, `<db>_<timestamp>.sql.gpg`, and matching `.sha256` files.

## 4. Deploy to a server

This section covers running `backup.js` unattended on a Linux server: locking down
the deployment directory, installing dependencies, and scheduling it with the
system's native cron.

### 4.1 Lay out and lock down the deployment directory

Pick a directory to hold the script, its `.env`, and the GPG passphrase file
together (e.g. `/etc/my-backup`). Keeping them in one directory makes the
permissions step simple: nothing in it should be readable by anyone but the
user that runs the backup.

```bash
sudo mkdir -p /etc/my-backup
sudo cp backup.js package.json package-lock.json /etc/my-backup/
sudo cp .env /etc/my-backup/backup.env
sudo cp /path/to/your/gpg-passphrase.txt /etc/my-backup/gpg-passphrase
```

Then, assuming a dedicated `backup` user/group will own and run it (swap in
`root:root` or another user if that's who runs the cron job):

```bash
sudo chown -R backup:backup /etc/my-backup
sudo chmod 700 /etc/my-backup

sudo chmod 700 /etc/my-backup/backup.js
sudo chmod 600 /etc/my-backup/backup.env
sudo chmod 600 /etc/my-backup/gpg-passphrase
```

- `700` on the directory means only its owner can list/enter it at all.
- `600` on `backup.env` and `gpg-passphrase` means only the owner can read or
  write them — nobody else can see the DB password, Supabase service-role key,
  or GPG passphrase.
- `700` on `backup.js` is enough for the owner to execute it via `node
backup.js`; it doesn't need to be readable/writable by anyone else.
- Update `GPG_PASSPHRASE_FILE` in `backup.env` to point at
  `/etc/my-backup/gpg-passphrase` (the path it lives at now).

Re-run the `chmod`/`chown` lines any time you replace these files (e.g. after
copying a new `.env` in) — copying a file does not preserve the permissions
you set previously.

### 4.2 Install dependencies on the server

The script needs Node.js, the Postgres client binaries (`pg_dump`,
`pg_restore`), and `gpg` on `PATH`, plus the `@supabase/supabase-js` npm
package. On a Debian/Ubuntu server:

```bash
# Node.js (via NodeSource; adjust major version as needed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Postgres client tools (pg_dump / pg_restore) — match the major version
# of the Postgres server you're backing up
sudo apt-get install -y postgresql-client

# GPG (usually preinstalled, included for completeness)
sudo apt-get install -y gnupg

# Verify versions
node -v
pg_dump --version
gpg --version
```

Then install the Node dependencies into the deployment directory:

```bash
cd /etc/my-backup
sudo -u backup npm install --omit=dev
```

This pulls in `@supabase/supabase-js` from `package.json`/`package-lock.json`.
Re-run `npm install` here whenever you update `package.json` on your
development machine and redeploy it.

### 4.3 Schedule it with cron

Edit the crontab for the same user that owns `/etc/my-backup` (so file
permissions from step 4.1 line up with the process that reads them):

```bash
sudo -u backup crontab -e
```

Add a line to run daily at 03:00, loading `backup.env` in a shell wrapper and
logging to a file:

```cron
0 3 * * * cd /etc/my-backup && bash -c 'export $(cat backup.env | xargs); node backup.js' >> /var/log/pg-dump.log 2>&1
```

Notes:

- The log file's directory must be writable by the cron user — e.g. `sudo
mkdir -p /var/log && sudo touch /var/log/pg-dump.log && sudo chown
backup:backup /var/log/pg-dump.log`, or point it somewhere under
  `/etc/my-backup` instead.
- Confirm the crontab entry is in place with `sudo -u backup crontab -l`.
- Cron runs with a minimal environment (no user `PATH` customizations) — if
  `node`, `pg_dump`, `pg_restore`, or `gpg` aren't found, use full paths
  (`/usr/bin/node`, etc., found via `which node`) in the cron command.
- Trigger a manual run of the exact cron command first (`cd /etc/my-backup &&
bash -c '...'`) to confirm it works before waiting on the schedule.

## Restoring

See [RESTORE.md](RESTORE.md) for the full restore procedure (download, decrypt, verify checksum, `pg_restore`/`psql`).
