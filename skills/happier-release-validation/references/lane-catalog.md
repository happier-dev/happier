# Lane Catalog

## Current Required Custom Checks

The required integrated command is:

```bash
node scripts/pipeline/run.mjs checks --profile custom --custom-checks ui_e2e,e2e_core,e2e_core_slow,server_db_contract,build_website,build_docs,cli_smoke_linux,release_assets_e2e
```

This resolves to:
- `runCi: true`
- `runUiE2e: true`
- `runE2eCore: true`
- `runE2eCoreSlow: true`
- `runServerDbContract: true`
- `runStress: false`
- `runBuildWebsite: true`
- `runBuildDocs: true`
- `runCliSmokeLinux: true`
- `runReleaseAssetsE2e: true`

Before each release, re-run:

```bash
node scripts/pipeline/run.mjs checks-plan --profile custom --custom-checks ui_e2e,e2e_core,e2e_core_slow,server_db_contract,build_website,build_docs,cli_smoke_linux,release_assets_e2e
```

If the repo has added release-critical checks, add them to `PLAN.md` as lanes and explain why.

## Risk Surface Expansion Checklist

During L01 drift analysis, map changed files and prior-audit findings onto these release-risk surfaces. Add dynamic lanes when a changed surface is not already covered by the generated plan.

- CLI packaging/runtime: published CLI, bundled internal workspaces, binary-safe execution with no system Node/package manager, `happier` entrypoints, update command paths.
- Daemon/service ownership: manual daemon, service-managed daemon, stale service files, duplicate lane/version services, socket reclaim, relay ownership, `daemon status --json`, `daemon start --json`, `service install --takeover`, `doctor repair`.
- Server/relay/data: auth, account identity, session persistence, migrations/storage compatibility, pending queue, websocket/socket reconnects, server runner artifacts.
- UI/web session flows: onboarding/login, terminal-connect URL auth, new-session wizard, provider picker, connected-services auth, session list/detail, send/stream/stop/tail/attach, HMR-disabled manual QA tabs.
- Provider launches: Claude, Codex, OpenCode, OpenCode Server, Gemini, Kilo, Kimi, Qwen, Auggie, PI; include provider-specific auth/materialization/restart behavior when available.
- Session storage/security: encrypted default sessions, plaintext opt-in sessions when enabled, sharing/public-share constraints, account isolation, wrong-account/wrong-relay guards.
- Installers/artifacts: Linux/macOS/Windows installer smoke, binary smoke where supported, artifact verification, local-build release assets, rollback/failed-update behavior.
- Cross-platform manual QA: Linux Lima, macOS host, Windows through `~/connect_windows.sh`, and native Android/iOS validate-only.
- Documentation and user guidance: installer prompts, conflict/repair messages, release notes for human-approved deferrals, docs build.

The checklist is intentionally broader than the default lane roster. It prevents missing a changed release-critical surface; it does not require inventing low-value lanes for unchanged or irrelevant areas.

## Important Additional Local Lanes

The custom checks command is necessary but insufficient for this release validation. Also run these local-first lanes when prerequisites exist.

### Baseline CI And Typecheck

```bash
yarn test
yarn test:integration
yarn typecheck
yarn -s test:release:contracts
node scripts/pipeline/run.mjs release-sync-installers --check
```

### Core E2E

```bash
yarn test:e2e:core:fast
yarn test:e2e:core:slow
```

### UI Web E2E

```bash
yarn test:e2e:ui
```

### Server DB And Static Builds

```bash
yarn test:db-contract:docker
yarn website:build
yarn docs:build
```

### Provider Smoke

Run all provider smoke lanes by default when prerequisites exist:

```bash
yarn test:providers:all:smoke
```

Equivalent per-provider lanes, useful for parallel dispatch and targeted fixes:

```bash
yarn test:providers:claude:smoke
yarn test:providers:codex:smoke
yarn test:providers:opencode:smoke
yarn test:providers:opencode_server:smoke
yarn test:providers:gemini:smoke
yarn test:providers:kilo:smoke
yarn test:providers:kimi:smoke
yarn test:providers:qwen:smoke
yarn test:providers:auggie:smoke
yarn test:providers:pi:smoke
```

Before running, verify the current provider list from root `package.json`:

```bash
node -e "const p=require('./package.json'); for (const k of Object.keys(p.scripts||{})) if (/^test:providers:.*:smoke$/.test(k)) console.log(k)"
```

If a provider prerequisite is missing, mark that provider `BLOCKED` with the exact missing credential/tool. Do not silently skip it.

### Mobile Validate Only

```bash
yarn test:e2e:mobile:android
yarn test:e2e:mobile:ios
```

Do not submit to EAS or app stores during validation unless explicitly approved.

## Release-Validation Suites

Use the unified runner:

```bash
node scripts/pipeline/run.mjs release-validate --suite <suite> ...
```

Known suites:
- `installers-smoke`
- `binary-smoke`
- `artifact-verify`
- `docker-release-assets`
- `cli-update`
- `daemon-continuity`
- `session-continuity`

## Artifact Source Policy

Validation is local-first and must not deploy the candidate.

- Published `preview` artifacts may be used only to establish the before-upgrade baseline.
- Candidate artifacts must come from the validation worktree: `--source local-build --ref .` for release-validation suites, or an explicitly recorded local build artifact copied to the VM/host/Windows machine.
- Do not use deployed preview install scripts to install or upgrade to the candidate. If an install script is used for the candidate, it must point at the local artifact under test and the evidence must record that path or URL.
- Do not publish npm packages, submit mobile builds, trigger deploy webhooks, push release branches, or invoke the non-dry-run release command during validation.
- Every installer/update lane must record artifact source, artifact path or transfer path, before/after versions, and whether the starting state came from published `preview` or a local candidate build.

Recommended pre-promotion local commands:

```bash
HAPPIER_RELEASE_ASSETS_E2E_MODE=local \
HAPPIER_RELEASE_ASSETS_E2E_MONOREPO=local \
node scripts/pipeline/run.mjs release-validate \
  --suite docker-release-assets --platform linux \
  --source local-build --ref .

node scripts/pipeline/run.mjs release-validate \
  --suite cli-update --platform linux \
  --from-source published-channel --from-ref preview \
  --to-source local-build --to-ref .

node scripts/pipeline/run.mjs release-validate \
  --suite daemon-continuity --platform linux \
  --source local-build --ref .

node scripts/pipeline/run.mjs release-validate \
  --suite session-continuity --platform linux \
  --source local-build --ref .

node scripts/pipeline/run.mjs release-validate \
  --suite installers-smoke --platform linux \
  --source local-build --ref . --release-channel preview

node scripts/pipeline/run.mjs release-validate \
  --suite installers-smoke --platform darwin \
  --source local-build --ref . --release-channel preview
```

The macOS installer-smoke command runs on the host machine and validates the macOS installer artifact directly. Windows installer smoke requires concrete Windows checkout or artifact transfer first, then native execution through `~/connect_windows.sh`.

## Final Dry-Run

Validation ends with a dry-run only:

```bash
node scripts/pipeline/run.mjs release \
  --confirm "release dev to preview" \
  --repository happier-dev/happier \
  --deploy-environment preview \
  --deploy-targets ui,server,website,docs,cli,server_runner \
  --bump none \
  --dry-run
```

Use `--bump none` when package versions are already the intended candidate versions. If versions are not pre-bumped, stop and ask before changing the bump mode.
