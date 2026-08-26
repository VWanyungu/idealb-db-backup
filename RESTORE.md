# dbbackup

This README covers **restoring a database from an encrypted dump** produced by either script.

## What you'll need before restoring

- The encrypted dump file downloaded from Supabase Storage (`<db>_<timestamp>.dump.gpg` and/or `<db>_<timestamp>.sql.gpg`)
- The matching `.sha256` checksum file, also in Supabase Storage
- Either:
  - your GPG **private key** (if the backup used `GPG_RECIPIENT` / asymmetric encryption), or
  - the **passphrase** used at backup time (if it used `GPG_PASSPHRASE_FILE` / symmetric encryption)
- `gpg`, `pg_restore` (for `.dump` files) or `psql` (for `.sql` files) installed locally
- Network access to the target Postgres server you're restoring into

## Step 1 — Download the files from Supabase Storage

```bash
supabase storage download <bucket>/<db>_<timestamp>.dump.gpg
supabase storage download <bucket>/<db>_<timestamp>.dump.gpg.sha256
```

Download both the `.dump.gpg` (or `.sql.gpg`) file and its `.sha256` sibling.

## Step 2 — Decrypt

**If the backup used asymmetric encryption (`GPG_RECIPIENT`)** — you need the corresponding private key imported into your local GPG keyring:

```bash
gpg --import your-private-key.asc
gpg --batch --yes -o <db>_<timestamp>.dump -d <db>_<timestamp>.dump.gpg
```

GPG will prompt for your private key's passphrase if it has one.

**If the backup used symmetric encryption (`GPG_PASSPHRASE_FILE`)** — you need the same passphrase used at backup time:

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

### Custom format (`.dump`) — supports selective/parallel restore

```bash
# Create the target database first if it doesn't exist
createdb -h <host> -U <user> <target_db>

# Restore
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
createdb -h <host> -U <user> <target_db>

PGPASSWORD=<password> psql \
  -h <host> -p <port> -U <user> -d <target_db> \
  -f <db>_<timestamp>.sql
```

## Step 5 — Sanity-check the restored database

Before treating the restore as complete:

- Confirm row counts on a few key tables against expectations.
- Confirm the most recent transaction/record timestamp in the restored data lines up with the backup's timestamp — this tells you exactly how much data (if any) is missing relative to the failure point.

## Step 6 — Clean up

Once restored and verified, securely delete the local decrypted plaintext dump

```bash
rm -u <db>_<timestamp>.dump
```
