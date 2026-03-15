import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const smokeDir = join(repoRoot, 'scripts', 'release', 'release-assets-e2e');

test('npm-e2e-smoke Dockerfile uses Node 22 policy', async () => {
  const dockerfilePath = join(smokeDir, 'Dockerfile');
  const raw = await readFile(dockerfilePath, 'utf8');
  assert.match(raw, /^FROM node:22-bookworm/m);
});

test('npm-e2e-smoke includes noninteractive terminal auth approver helper', async () => {
  const helper = join(smokeDir, 'bin', 'terminal-auth-approve.cjs');
  assert.ok(existsSync(helper), `missing helper: ${helper}`);
});

test('npm-e2e-smoke stack entrypoint uses stable stack-scoped server id by default', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /STACK_CLI_ID="\$\{STACK_CLI_ID:-stack_main__id_default\}"/,
    'expected stack smoke to default STACK_CLI_ID to the stable stack-scoped id to match stack daemon env scoping'
  );
});

test('npm-e2e-smoke stack entrypoint keeps container alive after start', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /\[stack\] keeping container alive/,
    'expected stack entrypoint to keep the docker container running after daemonized start'
  );
  assert.match(raw, /while\s+true;\s+do/, 'expected keepalive loop');
});

test('npm-e2e-smoke phase2 start forces a restart so UI serving is enabled', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /start_args=\(\n\s*start\n\s*--no-browser\n\s*--restart\n/m,
    'expected stack entrypoint to include --restart in phase2 start args (phase1 uses --no-ui)'
  );
});

test('npm-e2e-smoke phase1 stop is aggressive+sweeping to avoid lingering no-UI supervisor', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /stop --yes --aggressive --sweep-owned/,
    'expected stack entrypoint to stop phase1 with --aggressive --sweep-owned so phase2 can relaunch UI'
  );
});

test('npm-e2e-smoke explicitly kills the phase1 no-ui supervisor before phase2', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(raw, /\[stack\] killing phase1 supervisor/, 'expected explicit phase1 supervisor kill log');
  assert.match(raw, /--no-ui/, 'expected phase1 supervisor matcher to key off --no-ui');
  assert.match(raw, /kill -9/, 'expected a hard-kill fallback for stubborn supervisors');
});

test('npm-e2e-smoke phase1 supervisor detection uses wide ps output (avoids truncation)', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /ps\s+-eo\s+pid,args\s+-ww/,
    'expected phase1 supervisor detection to use ps -ww so the @happier-dev/stack/scripts/run.mjs path is not truncated'
  );
});

test('npm-e2e-smoke phase1 supervisor detection has a pgrep fallback', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(raw, /pgrep\s+-f/, 'expected a pgrep -f fallback for phase1 supervisor detection');
});

test('npm-e2e-smoke phase1 supervisor kill has an anchored pkill fallback', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /pkill\s+-9\s+-f\s+'\^\/usr\/local\/bin\/node .*run\\.mjs/,
    'expected a pkill -9 -f fallback anchored on /usr/local/bin/node to avoid matching the shell itself'
  );
});

test('npm-e2e-smoke kills lingering server-light process before phase2', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(raw, /kill_phase1_server_light/, 'expected a helper to kill phase1 server-light processes');
  assert.match(raw, /--import tsx/, 'expected smoke to key off the server-light entrypoint args');
});

test('npm-e2e-smoke uses --no-service for stop inside Docker', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /stop --yes --aggressive --sweep-owned --no-service/,
    'expected docker smoke to avoid systemctl by passing --no-service'
  );
});

test('npm-e2e-smoke stack bootstrap uses packaged happier-cli (not monorepo bin)', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(raw, /HAPPIER_NPM_SPEC=/, 'expected stack entrypoint to accept HAPPIER_NPM_SPEC');
  assert.match(raw, /HAPPIER_TGZ=/, 'expected stack entrypoint to accept HAPPIER_TGZ');
  assert.match(raw, /HAPPIER_CLI_INSTALL_MODE=/, 'expected stack entrypoint to accept HAPPIER_CLI_INSTALL_MODE');
  assert.match(raw, /\bnpx\b.*--yes.*-p/, 'expected stack entrypoint to support running happier via npx');
  assert.doesNotMatch(raw, /resolve_monorepo_cli_bin/, 'expected stack bootstrap to avoid monorepo cli bin');
  assert.doesNotMatch(raw, /workspace\/main/, 'expected stack bootstrap to avoid referencing cloned monorepo paths');
});

test('npm-e2e-smoke stack entrypoint forces non-production dependency installs (tsc available)', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(raw, /\bunset\s+NODE_ENV\b/, 'expected entrypoint to unset NODE_ENV so Yarn installs devDependencies');
  assert.match(raw, /\bunset\s+npm_config_production\b/, 'expected entrypoint to unset npm_config_production');
  assert.match(raw, /\bunset\s+YARN_PRODUCTION\b/, 'expected entrypoint to unset YARN_PRODUCTION');
});

test('npm-e2e-smoke stack run checks daemon registers a machine on the server', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const raw = await readFile(runnerPath, 'utf8');
  assert.match(raw, /\/v1\/machines/, 'expected smoke runner to probe /v1/machines for daemon connectivity');
  assert.match(raw, /access\.key/, 'expected smoke runner to read a token from access.key for authenticated probes');
});

test('npm-e2e-smoke cli smoke waits for daemon to register a machine (connected check)', async () => {
  const cliSmokePath = join(smokeDir, 'bin', 'cli-smoke.sh');
  const raw = await readFile(cliSmokePath, 'utf8');
  assert.match(raw, /find\s+"\$CLIENT_HOME_DIR"\s+-mindepth\s+1\s+-maxdepth\s+1\s+-exec\s+rm\s+-rf\s+\{\}\s+\+/, 'expected cli smoke to clear client home contents and avoid stale auth tokens across reruns');
  assert.match(raw, /find\s+"\$APPROVER_HOME_DIR"\s+-mindepth\s+1\s+-maxdepth\s+1\s+-exec\s+rm\s+-rf\s+\{\}\s+\+/, 'expected cli smoke to clear approver home contents and avoid stale auth tokens across reruns');
  assert.match(raw, /\/v1\/machines/, 'expected cli smoke to probe /v1/machines for daemon connectivity');
  assert.match(raw, /machine_count_before/, 'expected cli smoke to capture machines count before starting daemon');
  assert.match(raw, /machine_count_after/, 'expected cli smoke to observe machines count after starting daemon');
});

test('npm-e2e-smoke includes a second CLI machine smoke', async () => {
  const composePath = join(smokeDir, 'compose.yml');
  const composeRaw = await readFile(composePath, 'utf8');
  assert.match(composeRaw, /\n  cli2:\n/, 'expected a cli2 service in docker compose');
  assert.match(composeRaw, /\n  cli-home:\n/, 'expected a cli-home volume for cross-container account reuse');

  const cli2SmokePath = join(smokeDir, 'bin', 'cli2-smoke.sh');
  assert.ok(existsSync(cli2SmokePath), `missing cli2 smoke script: ${cli2SmokePath}`);
  const cli2Raw = await readFile(cli2SmokePath, 'utf8');
  assert.match(
    cli2Raw,
    /find\s+"\$CLIENT_HOME_DIR"\s+-mindepth\s+1\s+-maxdepth\s+1\s+-exec\s+rm\s+-rf\s+\{\}\s+\+/,
    'expected cli2 smoke to clear client home contents and avoid stale auth tokens across reruns'
  );

  const runnerPath = join(smokeDir, 'run.sh');
  const runnerRaw = await readFile(runnerPath, 'utf8');
  assert.match(runnerRaw, /run\s+--rm\s+--no-deps\s+cli2/, 'expected runner to execute cli2 smoke');
});

test('npm-e2e-smoke runner rebuilds cli images to avoid stale scripts', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const runnerRaw = await readFile(runnerPath, 'utf8');
  assert.match(runnerRaw, /compose.*build.*\bcli\b/, 'expected runner to build the cli image before running it');
  assert.match(runnerRaw, /compose.*build.*\bcli2\b/, 'expected runner to build the cli2 image before running it');
});

test('npm-e2e-smoke local mode packs tarballs with npm (yarn pack is flaky)', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const runnerRaw = await readFile(runnerPath, 'utf8');
  assert.match(runnerRaw, /\bnpm\b.*\bpack\b/, 'expected runner to use npm pack for local tarballs');
  assert.doesNotMatch(runnerRaw, /\byarn\b.*\bpack\b/, 'expected runner to avoid yarn pack');
});

test('npm-e2e-smoke supports --cli-install=npx to bypass global install', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const runnerRaw = await readFile(runnerPath, 'utf8');
  assert.match(runnerRaw, /--cli-install=/, 'expected runner to accept a --cli-install flag');
  assert.match(
    runnerRaw,
    /HAPPIER_CLI_INSTALL_MODE=/,
    'expected runner to pass CLI install mode via HAPPIER_CLI_INSTALL_MODE env'
  );

  const cliSmokePath = join(smokeDir, 'bin', 'cli-smoke.sh');
  const cliRaw = await readFile(cliSmokePath, 'utf8');
  assert.match(cliRaw, /HAPPIER_CLI_INSTALL_MODE/, 'expected cli smoke to read HAPPIER_CLI_INSTALL_MODE');
  assert.match(cliRaw, /\bnpx\b.*--yes.*-p/, 'expected cli smoke to support running via npx');

  const cli2SmokePath = join(smokeDir, 'bin', 'cli2-smoke.sh');
  const cli2Raw = await readFile(cli2SmokePath, 'utf8');
  assert.match(cli2Raw, /HAPPIER_CLI_INSTALL_MODE/, 'expected cli2 smoke to read HAPPIER_CLI_INSTALL_MODE');
  assert.match(cli2Raw, /\bnpx\b.*--yes.*-p/, 'expected cli2 smoke to support running via npx');
});

test('npm-e2e-smoke local monorepo mode uses a self-contained git clone (worktree safe)', async () => {
  const localComposePath = join(smokeDir, 'compose.local-monorepo.yml');
  const localComposeRaw = await readFile(localComposePath, 'utf8');
  assert.match(
    localComposeRaw,
    /LOCAL_MONOREPO_MOUNT/,
    'expected local-monorepo compose to mount a self-contained clone dir (not the dev worktree path)'
  );

  const runnerPath = join(smokeDir, 'run.sh');
  const runnerRaw = await readFile(runnerPath, 'utf8');
  assert.match(
    runnerRaw,
    /prepare-local-monorepo\.mjs/,
    'expected runner to prepare a self-contained git clone via prepare-local-monorepo.mjs for --monorepo=local'
  );
  assert.match(runnerRaw, /--src\s+"\$repo_root"/, 'expected runner to pass --src "$repo_root" to prepare-local-monorepo');
  assert.match(
    runnerRaw,
    /--dst\s+"\$local_monorepo_dir"/,
    'expected runner to pass --dst "$local_monorepo_dir" to prepare-local-monorepo'
  );
  assert.match(
    runnerRaw,
    /LOCAL_MONOREPO_MOUNT=/,
    'expected runner to pass LOCAL_MONOREPO_MOUNT via env-file for compose.local-monorepo.yml'
  );
});

test('npm-e2e-smoke local mode prepares a local linux server binary for remote server setup', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const runnerRaw = await readFile(runnerPath, 'utf8');
  assert.match(
    runnerRaw,
    /build-server-binaries\.mjs/,
    'expected local mode runner to build a local happier-server release binary for remote server smoke'
  );
  assert.match(
    runnerRaw,
    /REMOTE_SELF_HOST_SERVER_BINARY=/,
    'expected runner to export REMOTE_SELF_HOST_SERVER_BINARY for remote-server-smoke'
  );
  assert.match(
    runnerRaw,
    /REMOTE_SELF_HOST_PRISMA_ENGINE_PATH=/,
    'expected runner to export REMOTE_SELF_HOST_PRISMA_ENGINE_PATH for local binary runtime Prisma loading'
  );
  assert.match(
    runnerRaw,
    /server_runtime_root="\$\(dirname "\$server_binary"\)"/,
    'expected runner to stage the extracted server runtime root, not only the bare binary'
  );
  assert.match(
    runnerRaw,
    /REMOTE_SELF_HOST_SERVER_BINARY=\/packs\/happier-server-\$\{server_target\}-runtime\/happier-server/,
    'expected runner to point remote setup at the staged runtime binary path'
  );
});

test('npm-e2e-smoke remote server smoke forwards self-host server binary override to hstack remote setup', async () => {
  const remoteServerSmokePath = join(smokeDir, 'bin', 'remote-server-smoke.sh');
  const raw = await readFile(remoteServerSmokePath, 'utf8');
  assert.match(
    raw,
    /REMOTE_SSH_WAIT_SECONDS="\$\{REMOTE_SSH_WAIT_SECONDS:-180\}"/,
    'expected remote server smoke to expose a configurable ssh wait timeout for slow systemd host boot'
  );
  assert.match(
    raw,
    /for _ in \$\(seq 1 "\$REMOTE_SSH_WAIT_SECONDS"\); do/,
    'expected remote server smoke ssh readiness loop to use REMOTE_SSH_WAIT_SECONDS'
  );
  assert.match(
    raw,
    /--self-host-server-binary/,
    'expected remote server smoke to forward a self-host binary override when provided'
  );
  assert.match(
    raw,
    /PRISMA_QUERY_ENGINE_LIBRARY/,
    'expected remote server smoke to pass Prisma engine env overrides for local binary runs'
  );
});

test('npm-e2e-smoke compose remote server smoke forwards local self-host env overrides', async () => {
  const composeRemotePath = join(smokeDir, 'compose.remote.yml');
  const raw = await readFile(composeRemotePath, 'utf8');
  assert.match(
    raw,
    /REMOTE_SELF_HOST_SERVER_BINARY:\s*\$\{REMOTE_SELF_HOST_SERVER_BINARY:-\}/,
    'expected compose remote server smoke env to include REMOTE_SELF_HOST_SERVER_BINARY'
  );
  assert.match(
    raw,
    /REMOTE_SELF_HOST_PRISMA_ENGINE_PATH:\s*\$\{REMOTE_SELF_HOST_PRISMA_ENGINE_PATH:-\}/,
    'expected compose remote server smoke env to include REMOTE_SELF_HOST_PRISMA_ENGINE_PATH'
  );
});

test('hstack remote server setup supports self-host server binary override flag', async () => {
  const remoteCmdPath = join(repoRoot, 'apps', 'stack', 'scripts', 'remote_cmd.mjs');
  const raw = await readFile(remoteCmdPath, 'utf8');
  assert.match(
    raw,
    /--self-host-server-binary/,
    'expected remote setup usage and parser to include --self-host-server-binary'
  );
  assert.match(
    raw,
    /HAPPIER_SELF_HOST_SERVER_BINARY=/,
    'expected remote setup to pass HAPPIER_SELF_HOST_SERVER_BINARY to remote self-host install env'
  );
});

test('build-server-binaries stages Prisma postgres engine files for packaged server runtime', async () => {
  const buildScriptPath = join(repoRoot, 'scripts', 'pipeline', 'release', 'build-server-binaries.mjs');
  const raw = await readFile(buildScriptPath, 'utf8');
  assert.match(
    raw,
    /node_modules['"],\s*['"]\.prisma['"],\s*['"]client['"]/,
    'expected server binary packaging to stage node_modules/.prisma/client for postgres Prisma runtime engines'
  );
});

test('remote install shims keep npm cache bounded across repeated setup runs', async () => {
  const remoteHostPath = join(smokeDir, 'bin', 'remote-host-entrypoint.sh');
  const remoteHostSystemdPath = join(smokeDir, 'bin', 'remote-host-systemd-entrypoint.sh');

  const hostRaw = await readFile(remoteHostPath, 'utf8');
  const hostSystemdRaw = await readFile(remoteHostSystemdPath, 'utf8');
  assert.match(
    hostRaw,
    /cache_dir="\$\(mktemp -d "\$HOME\/\.happier\/\.npm-cache\.[X]{6}"\)"/,
    'expected remote daemon host shim to allocate an isolated npm cache directory per install run'
  );
  assert.match(
    hostRaw,
    /npm config set cache/,
    'expected remote daemon host shim to configure npm cache explicitly'
  );
  assert.match(
    hostRaw,
    /npm install -g \/packs\/cli\.tgz --no-audit --no-fund/,
    'expected remote daemon host shim to install cli tarball through npm so runtime dependencies are present'
  );
  assert.match(
    hostRaw,
    /rm -rf "\$cache_dir" "\$HOME\/\.npm\/_cacache"/,
    'expected remote daemon host shim to remove temporary npm cache after install'
  );
  assert.match(
    hostSystemdRaw,
    /npm config set cache/,
    'expected remote systemd install shim to configure an explicit npm cache directory'
  );
  assert.match(
    hostSystemdRaw,
    /npm cache clean --force/,
    'expected remote systemd install shim to clear npm cache to avoid ENOSPC across repeated installs'
  );
  assert.match(
    hostSystemdRaw,
    /rm -rf "\$prefix\/lib\/node_modules\/@happier-dev\/cli"/,
    'expected remote systemd install shim to remove existing @happier-dev/cli before reinstall'
  );
});

test('remote daemon host install shim avoids unnecessary hstack install', async () => {
  const remoteHostPath = join(smokeDir, 'bin', 'remote-host-entrypoint.sh');
  const raw = await readFile(remoteHostPath, 'utf8');
  assert.doesNotMatch(
    raw,
    /npm install -g \/packs\/stack\.tgz/,
    'expected remote daemon host shim to skip /packs/stack.tgz install to reduce disk usage and avoid ENOSPC'
  );
});
