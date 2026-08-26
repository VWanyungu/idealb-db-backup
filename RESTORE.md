# dbbackup

This README covers **restoring a database from an encrypted dump** produced by `backup.js`.

## What you'll need before restoring

- The encrypted dump file downloaded from Supabase Storage (`<db>_<timestamp>.dump.gpg` and/or `<db>_<timestamp>.sql.gpg`)
- The matching `.sha256` checksum file, also in Supabase Storage
- The **GPG passphrase file** — a local copy of the same file the backup used as `GPG_PASSPHRASE_FILE` (backups use GPG symmetric encryption, so decryption needs the identical passphrase, not just its value from memory)
- The target Postgres connection details (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, target database name) — typically the same values as the backup's `.env`, unless you're restoring into a different server/database
- `gpg`, `pg_restore` (for `.dump` files) or `psql` (for `.sql` files) installed locally
- Network access to the target Postgres server you're restoring into

## Step 1 — Download the files from Supabase Storage

Each backup run uploads both dump formats, each with its own encrypted file and checksum.
Download whichever format you intend to restore from — you don't need both, but the
commands below show both for reference:

```bash
# Custom format
supabase storage download <bucket>/<db>_<timestamp>.dump.gpg
supabase storage download <bucket>/<db>_<timestamp>.dump.sha256

# Plain SQL format
supabase storage download <bucket>/<db>_<timestamp>.sql.gpg
supabase storage download <bucket>/<db>_<timestamp>.sql.sha256
```

Always download a `.gpg` file together with its matching `.sha256` sibling — they must come from the same backup run.

## Step 2 — Decrypt

You need the same GPG passphrase file used at backup time (`GPG_PASSPHRASE_FILE`):
Ensure the output file name matched the pattern for step 3 (Checksum verification) to work

```bash
gpg --batch --yes --passphrase-file /path/to/passphrase.txt \
    -o <db>_<timestamp>.dump -d <db>_<timestamp>.dump.gpg
```

Or omit `--passphrase-file` to be prompted interactively:

```bash
gpg -o <db>_<timestamp>.dump -d <db>_<timestamp>.dump.gpg
```

## Step 3 — Verify the checksum

Now that you have the decrypted plaintext dump, confirm it matches the checksum captured at backup time:

```bash
sha256sum -c <db>_<timestamp>.dump.sha256
```

Expected output: `<db>_<timestamp>.dump: OK`. If this fails, **do not proceed** — the file may be corrupted or tampered with. Re-download and re-decrypt, or fall back to an earlier backup cycle.

## Step 4 — Restore into Postgres

You have two dump formats to choose from, depending on which one you downloaded:

First, connect to the target Postgres server and create the target database:

```bash
PGPASSWORD=<password> psql -h <host> -p <port> -U <user> -d postgres
```

Inside the `psql` prompt, create the database with DDL, then exit:

```sql
CREATE DATABASE <target_db>;
\q
```

With the database created, run the restore from your regular terminal (not inside `psql`):

### Custom format (`.dump`) — supports selective/parallel restore

```bash
PGPASSWORD=<password> pg_restore \
  -h <host> -p <port> -U <user> -d <target_db> \
  --no-owner --no-privileges \
  -j 4 \
  <db>_<timestamp>.dump
```

- `--no-owner --no-privileges` avoids failures if the restoring role doesn't match the original backup's role/ownership — grant privileges manually afterward if needed.
- `-j 4` parallelizes the restore (adjust to available CPU cores); omit for a single-threaded restore.
- Inspect the dump's contents first without restoring anything, if useful: `pg_restore --list <db>_<timestamp>.dump`

### Plain SQL format (`.sql`) — human-readable, restore via psql

```bash
PGPASSWORD=<password> psql \
  -h <host> -p <port> -U <user> -d <target_db> \
  -f <db>_<timestamp>.sql
```

## Step 5 — Sanity-check the restored database

Before treating the restore as complete:

- Confirm row counts on a few key tables against expectations.
- Confirm the most recent transaction/record timestamp in the restored data lines up with the backup's timestamp — this tells you exactly how much data (if any) is missing relative to the failure point.

```

```
