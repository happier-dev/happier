# Release assets E2E (Docker)

Repeatable manual end-to-end smoke for validating:
- `@happier-dev/stack` (`hstack`) can self-host + start a server
- `@happier-dev/cli` (`happier`) can point at that server and pass `happier server test`
- published Docker Hub images (`relay-server` + `dev-box`)

This is meant for release validation and can run against:
- real NPM dist-tags/versions (default)
- locally packed tarballs (`yarn pack`) before publishing

## Quick start (NPM `next`)

From repo root:

```bash
./scripts/release/release-assets-e2e/run.sh
```

## Run via pipeline checks

This is also wired into the pipeline checks runner:

```bash
node ./scripts/pipeline/run.mjs checks --profile release-assets
```

Defaults:
- `HAPPIER_RELEASE_ASSETS_E2E_MODE=local`
- `HAPPIER_RELEASE_ASSETS_E2E_MONOREPO=local` (when mode is `local`)
- `HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE=true` (upgrade existing server DB from Docker Hub image -> local build)

## Local tarballs (pre-publish)

```bash
./scripts/release/release-assets-e2e/run.sh --mode=local
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
  - When `postgres`, starts a Postgres container, passes `--env HAPPIER_DB_PROVIDER=postgres --env DATABASE_URL=...` to remote server setup, and verifies both a live server connection and at least one completed Prisma migration.
- `--remote-installer=shim|official`
  - `shim` (default in `--mode=local`): remote host overrides `curl https://happier.dev/install` to install from tarballs mounted at `/packs` (`cli.tgz` / `stack.tgz`).
    - In `--mode=local` these tarballs come from `npm pack` on your working tree.
    - In `--mode=npm` these tarballs come from `npm pack <spec>` (useful when the official installer is temporarily broken).
  - `official` (default in `--mode=npm`): remote host uses the real installer at `https://happier.dev/install`.
- `--remote-auth-mode=reuse-cli|bootstrap` (default: `reuse-cli`)
  - `reuse-cli`: authenticates the remote daemon onto the exact same account as the already-authenticated `cli` smoke machine (uses its home volume).
  - `bootstrap`: remote daemon smoke creates a separate local approver identity specifically to approve the remote machine pairing.
- `--with-docker-images` / `--no-docker-images` (default: `off`)
  - When enabled, also validates the published Docker Hub images:
    - `happierdev/relay-server:<channel>` runs with SQLite by default and can be configured for Postgres.
    - `happierdev/dev-box:<channel>` runs `happier` in a “preinstalled” mode against the relay server.
- `--docker-channel=preview|stable` (default: `preview`)
- `--docker-images-db=sqlite|postgres|both` (default: `both`)
- `--with-relay-upgrade` / `--no-relay-upgrade` (default: `off`)
  - Runs an upgrade test for `happierdev/relay-server:<channel>`:
    - start the Docker Hub image (`from`)
    - create real auth data in the DB (via `/v1/auth`)
    - restart with a locally-built relay-server image from your current checkout (`to`)
    - verify the old token still works after the upgrade
- `--relay-upgrade-from-channel=preview|stable` (default: `--docker-channel` value)
- `--relay-upgrade-db=sqlite|postgres|both` (default: `both`)

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
docker compose -f ./scripts/release/release-assets-e2e/compose.yml logs -f stack
```

## Desktop setup (`desktop-setup` suite)

What a user hits when they download the desktop app, on Linux: `desktop-setup.mjs` extracts the
`hsetup` that a desktop `.deb`/`.AppImage` bundles (`usr/lib/<product>/binaries/hsetup-*.gz`) and
drives `setup.thisComputer.v1` headlessly over its JSON-lines protocol, answering the pairing prompt
as the signed-in app would. It uses its own small compose project (`compose.desktop-setup.yml`): a
published `happierdev/relay-server` image, an approver container that owns the account, a
`release-feed` container, and systemd machines built from `Dockerfile.remote-host-systemd` with no
Happier CLI, daemon or service installed.

```bash
node scripts/pipeline/run.mjs release-validate --suite desktop-setup --platform linux \
  --source published-tag --ref cli-v<candidate> --desktop-artifact <path/to/happier-ui-desktop-…deb|AppImage>
# or directly, with a local directory of CLI release assets:
node scripts/release/release-assets-e2e/desktop-setup.mjs --desktop-artifact <deb|AppImage> --cli-assets-dir <dir> [--keep]
```

- **CLI feed.** hsetup reads `https://api.github.com/repos/<repo>/releases/tags/cli-*` (no override
  exists). Inside the compose network only, `release-feed` answers for `api.github.com` (network alias
  + a throwaway CA passed via `NODE_EXTRA_CA_CERTS`) and lists the staged assets. Nothing is re-signed:
  hsetup still verifies the minisign signature against the key embedded in its build, so the CLI
  assets must be signed by that key (a published `cli-v<version>` release, or a build signed with it).
  Assets signed with a throwaway key fail verification by design.
- **fresh-setup** (desktop1): asserts the CLI was acquired from the feed at the version under test and
  is `managed`, the only prompt is the pairing, a systemd user service is enabled and active,
  `daemon status` `runtimeConvergence` is fully true (INV8), `happier` on a login PATH is
  `~/.happier/bin/happier`, and the machine answers a relay-routed `capabilities.describe` RPC with an
  empty payload (INV10; `bin/machine-rpc-probe.mjs`).
- **upgrade** (desktop2): the published stable desktop is pinned from `ui-desktop-stable` to its
  immutable `ui-desktop-v*` tag; its source CLI manifest selects the matching immutable `cli-v*`
  baseline, so an already-advanced `cli-stable` feed cannot replace the predecessor (override with
  `--upgrade-from-desktop-tag` / `--upgrade-from-cli-tag`) set the machine up; then the new hsetup's
  setup and `cli.update.v1` run. The daemon must end on the new CLI (`cliVersionMatches`), as the same
  machine, still answering through the relay. The daemon version between the new setup and the update
  is recorded in `summary.json` (`afterNewSetup`).
- The systemd entrypoint enables lingering for the machine user, so the user manager and its bus exist
  for non-PAM sessions (`docker exec`), as they do in a desktop session.
- The upgrade drives the baseline hsetup with the params that released app sent, keyed by its tag
  (`PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG` in `desktop-setup-driver.mjs`; 0.2.12 sent
  `{ surface: 'desktop.ui', target: 'thisComputer' }`). A baseline not listed there is reported
  BLOCKED instead of being driven with another version's contract.
- The 0.2.12 predecessor's read-only first-launch inspection acquires its staged CLI, then that
  CLI's public `server set` selects the Docker relay before setup. Both the released hsetup's
  `server current` and its default-following service read the persisted profile. Caller-only URL
  overrides would pair against Docker while leaving the service pointed at the saved cloud relay;
  the harness therefore runs predecessor setup and subsequent observations without those overrides.
- Requires an x86_64 Linux Docker host (Linux desktop artifacts ship for x86_64 only). The suite
  gates the desktop build, not release verification: `build-tauri.yml` job `desktop_setup` runs it
  on `ubuntu-latest` against the just-finalized `tauri-updates-production-linux-x86_64` `.deb`, and
  `publish_stable_release` needs it. The job checks out the admitted workflow's immutable control
  SHA, so a harness-only fix does not change the runtime bytes under test. The runtime under test
  still comes from that finalized `.deb` and the selected published CLI release, not the control
  checkout. Artifact reuse still depends on the enclosing release's existing recovery path;
  changing the harness checkout does not add a new reuse path. The registry (`resolve-validation-plan.mjs --suite
  desktop-setup`; `registry.mjs` `resolveReleaseValidationSuiteApplicability` and
  `resolveDesktopSetupCliSource`) decides both whether it runs and which CLI it installs:
  - it runs only for a **production** build, because the upgrade scenario's pinned predecessor
    exists only there; otherwise the job succeeds with a `desktop-setup skipped` notice naming the
    reason (`no pinned <channel> predecessor for the upgrade scenario`);
  - the CLI is the release's candidate `cli-v<candidate_cli_version>` (forwarded by `release.yml`
    → `promote-ui.yml`, and `nightly-dev.yml`); a desktop-only release (no CLI candidate) installs
    the published `cli-stable` instead, pinned once to its immutable `cli-v<version>`
    (`--cli-channel stable`; the resolved tag is recorded in `summary.json`), which is what users
    of that desktop would get.
  The suite step's hard stop is twice the registry's 10-minute budget; the executor warns past the
  budget. No release-verification profile lists the suite, so `include_validation_suites` /
  `waive_validation_suites` refuse it and a release runs it once.
- **Explicit exception: `retry_version`.** A production `build-tauri.yml` run with `retry_version`
  re-promotes an existing immutable `ui-desktop-v<version>` release to the stable feed without
  rebuilding, and does not run the gate. Re-promoting previously released bytes is a recovery
  operation (`docs/release-process.md`), not a new publication; those bytes were gated when
  `publish_stable_release` first published them.
