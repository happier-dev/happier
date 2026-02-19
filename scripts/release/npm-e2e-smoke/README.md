# NPM E2E smoke (Docker)

Repeatable manual end-to-end smoke for validating:
- `@happier-dev/stack` (`hstack`) can self-host + start a server
- `@happier-dev/cli` (`happier`) can point at that server and pass `happier server test`

This is meant for release validation and can run against:
- real NPM dist-tags/versions (default)
- locally packed tarballs (`yarn pack`) before publishing

## Quick start (NPM `next`)

From repo root:

```bash
./scripts/release/npm-e2e-smoke/run.sh
```

## Local tarballs (pre-publish)

```bash
./scripts/release/npm-e2e-smoke/run.sh --mode=local
```

## Options

- `--mode=npm|local` (default: `npm`)
- `--stack-spec <npmSpec>` (default: `@happier-dev/stack@next`)
- `--cli-spec <npmSpec>` (default: `@happier-dev/cli@next`)
- `--cli-install=global|npx` (default: `global`)
  - `global`: `npm install -g` inside the cli containers (catches packaging issues)
  - `npx`: run via `npx -p <spec> happier ...` (useful if a dist-tag is temporarily broken for global installs)
- `--keep` keep containers/volumes running after the run (useful for debugging)
- `--timeout-s <seconds>` wait budget for first-time bootstrap/start (default: 1800)
- `--monorepo=github|local` (default: `github`)
  - `github`: hstack clones from GitHub (release-like)
  - `local`: hstack clones from your local repo checkout mounted into Docker (read-only; includes your working tree, including uncommitted changes)
- `--with-remote-daemon` / `--no-remote-daemon`
  - In `--mode=local`, remote daemon smoke is enabled by default.
  - This exercises `hstack remote daemon setup --ssh ...` against an sshd container and then starts the remote daemon.
- `--with-remote-server` / `--no-remote-server`
  - In `--mode=local`, remote server smoke is enabled by default.
  - This exercises `hstack remote server setup --ssh ...` against a systemd-enabled ssh container and waits for the remote server to become healthy.
- `--remote-server-db=postgres|sqlite` (default: `postgres`)
  - When `postgres`, starts a Postgres container and passes `--env HAPPIER_DB_PROVIDER=postgres --env DATABASE_URL=...` to remote server setup.
- `--remote-installer=shim|official`
  - `shim` (default in `--mode=local`): remote host overrides `curl https://happier.dev/install` to install from tarballs mounted at `/packs` (`cli.tgz` / `stack.tgz`).
    - In `--mode=local` these tarballs come from `npm pack` on your working tree.
    - In `--mode=npm` these tarballs come from `npm pack <spec>` (useful when the official installer is temporarily broken).
  - `official` (default in `--mode=npm`): remote host uses the real installer at `https://happier.dev/install`.
- `--remote-auth-mode=reuse-cli|bootstrap` (default: `reuse-cli`)
  - `reuse-cli`: authenticates the remote daemon onto the exact same account as the already-authenticated `cli` smoke machine (uses its home volume).
  - `bootstrap`: remote daemon smoke creates a separate local approver identity specifically to approve the remote machine pairing.

## What it does

1) Starts container `stack` and runs:
- `hstack setup --profile=selfhost --non-interactive ... --no-start-now`
- phase 1: `hstack start --no-daemon --no-ui --no-browser` (bring up server for auth bootstrap)
- non-interactive auth bootstrap (creates an account via `/v1/auth`, then runs `happier auth request/approve/wait` to write credentials)
- phase 2: `hstack start --no-browser` (server + UI + daemon)

2) Runs container `cli` and validates:
- `happier server set --server-url http://stack:3005 ...`
- non-interactive auth bootstrap + `GET /v1/account/profile`
- `happier server test` (probes `GET /v1/version`)
- `happier daemon start` + `happier daemon status`

If something fails, re-run with `--keep` and inspect logs:

```bash
docker compose -f ./scripts/release/npm-e2e-smoke/compose.yml logs -f stack
```
