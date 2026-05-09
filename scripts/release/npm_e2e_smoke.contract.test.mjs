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
  assert.match(
    raw,
    /resolve_happier_prefix_from_npm_global_package/,
    'expected stack bootstrap to resolve happier-cli from the global @happier-dev/cli package path so auth bootstrap can bypass stack-managed happier shims'
  );
  assert.match(
    raw,
    /@happier-dev\/cli\/dist\/index\.mjs/,
    'expected stack bootstrap to execute the packaged @happier-dev/cli dist entrypoint directly'
  );
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

test('npm-e2e-smoke stack entrypoint retries transient npm install network failures', async () => {
  const entrypointPath = join(smokeDir, 'bin', 'stack-entrypoint.sh');
  const raw = await readFile(entrypointPath, 'utf8');
  assert.match(
    raw,
    /npm_install_with_retry/,
    'expected stack entrypoint to provide a bounded npm install retry helper for transient network failures'
  );
  assert.match(
    raw,
    /ETIMEDOUT|ECONNRESET|network read ETIMEDOUT/,
    'expected stack entrypoint retry helper to classify transient npm network timeout/reset signatures'
  );
  assert.match(
    raw,
    /npm_install_with_retry[\s\S]*npm install -g/,
    'expected stack entrypoint to route global npm installs through the retry helper'
  );
});

test('npm-e2e-smoke stack run checks daemon registers a machine on the server', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const raw = await readFile(runnerPath, 'utf8');
  assert.match(raw, /\/v1\/machines/, 'expected smoke runner to probe /v1/machines for daemon connectivity');
  assert.match(raw, /access\.key/, 'expected smoke runner to read a token from access.key for authenticated probes');
});

test('npm-e2e-smoke resolves stack cli access.key dynamically from canonical servers directory', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const raw = await readFile(runnerPath, 'utf8');
  assert.match(
    raw,
    /cli_servers_dir="\/root\/\.happier\/stacks\/main\/cli\/servers"/,
    'expected smoke runner to resolve stack cli credentials from the canonical servers directory'
  );
  assert.match(
    raw,
    /find "\$cli_servers_dir" -mindepth 2 -maxdepth 2 -type f -name 'access\.key'/,
    'expected smoke runner to discover access.key files dynamically when server-id shapes change'
  );
  assert.doesNotMatch(
    raw,
    /access_key="\/root\/\.happier\/stacks\/main\/cli\/servers\/stack_main__id_default\/access\.key"/,
    'expected smoke runner to avoid a single hardcoded server-id credential path'
  );
});

test('npm-e2e-smoke cli smoke waits for daemon to register a machine (connected check)', async () => {
  const cliSmokePath = join(smokeDir, 'bin', 'cli-smoke.sh');
  const raw = await readFile(cliSmokePath, 'utf8');
  assert.match(
    raw,
    /command -v happier/,
    'expected cli smoke to verify the installed happier command is present on PATH'
  );
  assert.match(
    raw,
    /\bhappier\b --version/,
    'expected cli smoke to execute the real installed happier shim command for version proof'
  );
  assert.match(
    raw,
    /HAPPIER_PREFIX=\(happier\)/,
    'expected cli smoke to run flow commands through the installed happier shim'
  );
  assert.doesNotMatch(
    raw,
    /HAPPIER_PREFIX=\(node "\$expected"\)/,
    'expected cli smoke to avoid bypassing the installed command with direct node dist/index.mjs execution'
  );
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
    /command -v happier/,
    'expected cli2 smoke to verify the installed happier command is present on PATH'
  );
  assert.match(
    cli2Raw,
    /\bhappier\b --version/,
    'expected cli2 smoke to execute the real installed happier shim command for version proof'
  );
  assert.match(
    cli2Raw,
    /HAPPIER_PREFIX=\(happier\)/,
    'expected cli2 smoke to run flow commands through the installed happier shim'
  );
  assert.doesNotMatch(
    cli2Raw,
    /HAPPIER_PREFIX=\(node "\$expected"\)/,
    'expected cli2 smoke to avoid bypassing the installed command with direct node dist/index.mjs execution'
  );
  assert.match(
    cli2Raw,
    /find\s+"\$CLIENT_HOME_DIR"\s+-mindepth\s+1\s+-maxdepth\s+1\s+-exec\s+rm\s+-rf\s+\{\}\s+\+/,
    'expected cli2 smoke to clear client home contents and avoid stale auth tokens across reruns'
  );
  assert.match(
    cli2Raw,
    /find "\$approver_servers_dir" -mindepth 2 -maxdepth 2 -type f -name 'access\.key'/,
    'expected cli2 smoke to discover approver access keys dynamically when active server ids drift'
  );
  assert.match(
    cli2Raw,
    /selected_approver_server_id="\$\(basename "\$\(dirname "\$selected_approver_access_key"\)"\)"/,
    'expected cli2 smoke to derive active server id from the selected approver access-key path'
  );
  assert.match(
    cli2Raw,
    /HAPPIER_ACTIVE_SERVER_ID="\$selected_approver_server_id"/,
    'expected cli2 smoke to scope client/approver auth commands to the selected approver server id'
  );
  assert.doesNotMatch(
    cli2Raw,
    /if \[\[ ! -f "\$APPROVER_HOME_DIR\/servers\/\$HAPPIER_ACTIVE_SERVER_ID\/access\.key" \]\]/,
    'expected cli2 smoke to avoid failing immediately on a single hardcoded approver access-key path'
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

test('npm-e2e-smoke remote server smoke forwards canonical server binary override to hstack remote setup', async () => {
  const remoteServerSmokePath = join(smokeDir, 'bin', 'remote-server-smoke.sh');
  const raw = await readFile(remoteServerSmokePath, 'utf8');
  assert.match(
    raw,
    /resolve_happier_prefix_from_npm_global_package/,
    'expected remote server smoke to resolve packaged CLI entrypoint from global @happier-dev/cli package'
  );
  assert.match(
    raw,
    /ensure_happier_command_from_global_cli_package/,
    'expected remote server smoke to expose a stable `happier` command for hstack remote setup'
  );
  assert.match(
    raw,
    /bin\/happier\.mjs/,
    'expected remote server smoke to source happier command from packaged cli bin/happier.mjs'
  );
  assert.match(
    raw,
    /ln -sf "\$expected" \/usr\/local\/bin\/happier/,
    'expected remote server smoke to install a deterministic happier compatibility symlink in /usr/local/bin'
  );
  assert.match(
    raw,
    /setup_output="\$\(hstack remote server setup/,
    'expected remote server smoke to capture hstack remote setup output for failure diagnostics'
  );
  assert.doesNotMatch(
    raw,
    /~\/\.happier\/bin\/hstack/,
    'expected remote server smoke to avoid hardcoded remote hstack paths (remote install roots can vary)'
  );
  assert.match(
    raw,
    /remote_config_env_path="\/etc\/happier/,
    'expected remote server smoke to resolve canonical remote relay config env path for system mode'
  );
  assert.match(
    raw,
    /sudo -n cat \\"\$remote_config_env_path\\"/,
    'expected remote server smoke to read remote relay env config directly via sudo for deterministic verification'
  );
  assert.match(
    raw,
    /if \[\[ \$setup_status -ne 0 \]\]; then/,
    'expected remote server smoke to check hstack remote setup exit status explicitly'
  );
  assert.match(
    raw,
    /echo "\$setup_output" >&2/,
    'expected remote server smoke to print captured setup output when remote setup fails'
  );
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
    /ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=\/dev\/null -o ConnectTimeout=5/,
    'expected remote server smoke ssh readiness probe to bypass strict host checks before known_hosts is seeded'
  );
  assert.match(
    raw,
    /--ssh-config-file/,
    'expected remote server smoke to pass an ssh config file to hstack remote setup so host-key trust policy is explicit'
  );
  assert.match(
    raw,
    /--known-hosts-path/,
    'expected remote server smoke to pass an explicit known_hosts path to hstack remote setup for strict host-key verification'
  );
  assert.match(
    raw,
    /ssh-keyscan/,
    'expected remote server smoke to seed known_hosts before strict hstack remote setup'
  );
  assert.match(
    raw,
    /keyscan_args=\(-T 5 -t ed25519\)/,
    'expected remote server smoke known_hosts seeding to scan deterministic ED25519 host keys'
  );
  assert.match(
    raw,
    /ssh-keygen -R "\$host" -f "\$known_hosts_file"/,
    'expected remote server smoke to remove stale known_hosts entries before reseeding strict host trust'
  );
  assert.match(raw, /--server-binary/, 'expected remote server smoke to forward the canonical server binary override flag');
  assert.doesNotMatch(
    raw,
    /--self-host-server-binary/,
    'expected remote server smoke to avoid the legacy self-host server binary override flag'
  );
  assert.match(
    raw,
    /PRISMA_QUERY_ENGINE_LIBRARY/,
    'expected remote server smoke to pass Prisma engine env overrides for local binary runs'
  );
});

test('npm-e2e-smoke fails fast when stack bootstrap container exits during server readiness wait', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const raw = await readFile(runnerPath, 'utf8');
  const composePath = join(smokeDir, 'compose.yml');
  const composeRaw = await readFile(composePath, 'utf8');
  assert.match(
    composeRaw,
    /HSTACK_E2E_WITH_UI:\s*\$\{HSTACK_E2E_WITH_UI:-1\}/,
    'expected compose stack env to forward HSTACK_E2E_WITH_UI so run.sh can disable UI bootstrap deterministically'
  );
  assert.match(
    raw,
    /echo "HSTACK_E2E_WITH_UI=0"/,
    'expected release-assets stack smoke to disable UI dependency/bootstrap path for deterministic server readiness'
  );
  assert.match(
    raw,
    /stack container exited before server became ready/,
    'expected stack bootstrap wait loop to fail fast when the stack container exits instead of waiting full timeout'
  );
  assert.match(
    raw,
    /docker inspect -f '\{\{\.State\.Status\}\}'/,
    'expected stack bootstrap wait loop to inspect the live stack container state while waiting'
  );
  assert.match(
    raw,
    /stack container is missing before server became ready/,
    'expected stack bootstrap wait loop to fail fast when the stack container has disappeared before readiness'
  );
  assert.match(
    raw,
    /exec -T stack bash -lc 'curl -fsS http:\/\/127\.0\.0\.1:3005\/v1\/version >/,
    'expected stack readiness wait to use API health at /v1/version'
  );
  assert.doesNotMatch(
    raw,
    /exec -T stack bash -lc 'curl -fsS http:\/\/127\.0\.0\.1:3005\/v1\/version[^']*&&[^']*curl -fsS http:\/\/127\.0\.0\.1:3005\/[^']*grep -qi "<html"/,
    'expected stack readiness wait to avoid blocking on root HTML availability'
  );
});

test('npm-e2e-smoke retries docker compose build/up on transient docker auth registry failures', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const raw = await readFile(runnerPath, 'utf8');
  assert.match(
    raw,
    /docker_retry_attempts=/,
    'expected release-assets runner to define bounded docker retry attempts for transient registry/auth failures'
  );
  assert.match(
    raw,
    /retry_docker_compose_transient/,
    'expected release-assets runner to provide a dedicated docker transient retry helper'
  );
  assert.match(
    raw,
    /auth\.docker\.io\/token/,
    'expected release-assets runner to classify docker auth token endpoint failures as transient'
  );
  assert.match(
    raw,
    /504 Gateway Timeout/,
    'expected release-assets runner to classify 504 registry/token gateway failures as transient'
  );
  assert.match(
    raw,
    /retry_docker_compose_transient[\s\S]*\bbuild\b/,
    'expected release-assets runner to wrap compose build with transient retry containment'
  );
  assert.match(
    raw,
    /retry_docker_compose_transient[\s\S]*\bup\b[\s\S]*\bstack\b/,
    'expected release-assets runner to wrap stack startup compose up with transient retry containment'
  );
});

test('npm-e2e-smoke retries transient docker daemon removal races during stack startup', async () => {
  const runnerPath = join(smokeDir, 'run.sh');
  const raw = await readFile(runnerPath, 'utf8');
  assert.match(
    raw,
    /marked for removal and cannot be started/,
    'expected release-assets runner to classify docker daemon container-removal races as transient startup failures'
  );
  assert.match(
    raw,
    /retry_docker_compose_transient[\s\S]*compose up stack/,
    'expected release-assets runner to keep stack startup inside the bounded retry helper'
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
});

test('build-server-binaries stages Prisma postgres engine files for packaged server runtime', async () => {
  const buildScriptPath = join(repoRoot, 'scripts', 'pipeline', 'release', 'build-server-binaries.mjs');
  const raw = await readFile(buildScriptPath, 'utf8');
  const sharedBuilderPath = join(repoRoot, 'packages', 'cli-common', 'src', 'componentArtifacts', 'serverSidecars.ts');
  const sharedRaw = await readFile(sharedBuilderPath, 'utf8');
  assert.match(
    raw,
    /buildServerBinaryArtifactPayload/,
    'expected release server binary script to delegate runtime staging to the shared component artifact builder'
  );
  assert.match(
    sharedRaw,
    /node_modules['"],\s*['"]\.prisma['"],\s*['"]client['"]/,
    'expected shared server binary staging to include node_modules/.prisma/client for postgres Prisma runtime engines'
  );
  assert.match(
    sharedRaw,
    /node_modules['"],\s*['"]@prisma['"],\s*['"]client['"]/,
    'expected shared server binary staging to include node_modules/@prisma/client for postgres Prisma runtime imports'
  );
});

test('release binary scripts load cli-common artifact builders through the lazy dist loader', async () => {
  const cliBuildPath = join(repoRoot, 'scripts', 'pipeline', 'release', 'build-cli-binaries.mjs');
  const serverBuildPath = join(repoRoot, 'scripts', 'pipeline', 'release', 'build-server-binaries.mjs');
  const binaryReleaseLibPath = join(repoRoot, 'scripts', 'pipeline', 'release', 'lib', 'binary-release.mjs');

  const cliBuildRaw = await readFile(cliBuildPath, 'utf8');
  const serverBuildRaw = await readFile(serverBuildPath, 'utf8');
  const binaryReleaseLibRaw = await readFile(binaryReleaseLibPath, 'utf8');

  assert.doesNotMatch(
    cliBuildRaw,
    /@happier-dev\/cli-common\/componentArtifacts/,
    'expected build-cli-binaries to avoid direct cli-common dist imports'
  );
  assert.doesNotMatch(
    serverBuildRaw,
    /@happier-dev\/cli-common\/componentArtifacts/,
    'expected build-server-binaries to avoid direct cli-common dist imports'
  );
  assert.match(
    binaryReleaseLibRaw,
    /loadCliCommonDistModule/,
    'expected binary-release helpers to lazy-load cli-common dist modules on demand'
  );
  assert.match(
    binaryReleaseLibRaw,
    /buildServerBinaryArtifactPayload/,
    'expected binary-release helpers to re-export the shared server artifact builder'
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
    /npm install -g --force \/packs\/cli\.tgz --no-audit --no-fund/,
    'expected remote daemon host shim to force-reinstall the cli tarball through npm so repeated setup runs remain idempotent while runtime dependencies are present'
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

test('remote daemon reuse-cli smoke resolves primary access key dynamically and avoids command-substitution hints', async () => {
  const path = join(smokeDir, 'bin', 'remote-daemon-authenticated-cli-smoke.sh');
  const raw = await readFile(path, 'utf8');
  assert.match(
    raw,
    /find "\$cli_servers_dir" -mindepth 2 -maxdepth 2 -type f -name 'access\.key'/,
    'expected remote daemon reuse-cli smoke to discover primary access keys dynamically under the canonical servers directory'
  );
  assert.doesNotMatch(
    raw,
    /access_key="\$\{PRIMARY_CLI_HOME_DIR\}\/servers\/\$\{HAPPIER_ACTIVE_SERVER_ID\}\/access\.key"/,
    'expected remote daemon reuse-cli smoke to avoid a single hardcoded primary access key path'
  );
  assert.doesNotMatch(
    raw,
    /`cli`/,
    'expected remote daemon reuse-cli hint text to avoid shell command substitution in diagnostics'
  );
  assert.match(
    raw,
    /selected_server_id="\$\(basename "\$\(dirname "\$selected_access_key"\)"\)"/,
    'expected remote daemon reuse-cli smoke to derive active server id from the selected access-key path'
  );
  assert.match(
    raw,
    /export HAPPIER_ACTIVE_SERVER_ID="\$selected_server_id"/,
    'expected remote daemon reuse-cli smoke to export the selected server id so hstack and happier use the matching profile'
  );
  assert.match(
    raw,
    /remote_setup_output="\$\(mktemp -t remote-daemon-reuse-cli-setup-XXXXXX\)"/,
    'expected remote daemon reuse-cli smoke to capture remote setup output in a temp log'
  );
  assert.match(
    raw,
    /tail -n 200 "\$remote_setup_output" >&2/,
    'expected remote daemon reuse-cli smoke to print setup output on failure for deterministic root-cause diagnostics'
  );
  assert.doesNotMatch(
    raw,
    /hstack remote daemon setup \\\nremote_setup_output=/,
    'expected remote daemon reuse-cli smoke to avoid a dangling pre-command continuation before the captured setup invocation'
  );
  assert.doesNotMatch(
    raw,
    /retrying without --public-server-url compatibility flag/,
    'expected remote daemon reuse-cli smoke to fail closed instead of retrying without --public-server-url'
  );
  assert.doesNotMatch(
    raw,
    /Unknown machine setup arguments: --public-server-url/,
    'expected remote daemon reuse-cli smoke to avoid arg-shape compatibility fallback signatures'
  );
});

test('remote daemon smoke scripts fail closed when --public-server-url is unsupported', async () => {
  const reuseCliPath = join(smokeDir, 'bin', 'remote-daemon-authenticated-cli-smoke.sh');
  const reuseCliRaw = await readFile(reuseCliPath, 'utf8');
  assert.doesNotMatch(
    reuseCliRaw,
    /retrying without --public-server-url compatibility flag/,
    'expected reuse-cli remote daemon smoke to fail closed instead of retrying without --public-server-url'
  );
  assert.doesNotMatch(
    reuseCliRaw,
    /Unknown machine setup arguments: --public-server-url/,
    'expected reuse-cli remote daemon smoke to avoid unsupported --public-server-url compatibility signatures'
  );
  assert.match(
    reuseCliRaw,
    /hstack remote daemon setup[\s\S]*--yes/,
    'expected reuse-cli remote daemon setup to force --yes in non-interactive mode for SSH trust prompts'
  );
  assert.match(
    reuseCliRaw,
    /resolve_remote_happier_command\(\)/,
    'expected reuse-cli remote daemon smoke to resolve the installed remote CLI shim dynamically'
  );
  assert.match(
    reuseCliRaw,
    /~\/\.happier\/bin\/h(prev|appier)/,
    'expected reuse-cli remote daemon smoke to probe channel-specific managed shims on the remote host'
  );
  assert.match(
    reuseCliRaw,
    /~\/\.happier\/cli-preview\/current\/happier/,
    'expected reuse-cli remote daemon smoke to probe installer-managed preview CLI payload paths when ~/.happier/bin is absent'
  );
  assert.doesNotMatch(
    reuseCliRaw,
    /ssh "\$REMOTE_SSH_TARGET" "~\/\.happier\/bin\/happier daemon start"/,
    'expected reuse-cli remote daemon smoke to avoid hardcoding a stable-only remote CLI path'
  );
  assert.match(
    reuseCliRaw,
    /checking remote daemon connectivity after setup/,
    'expected reuse-cli remote daemon smoke to verify machine registration after setup before forcing manual daemon start'
  );
  assert.match(
    reuseCliRaw,
    /auth status --json/,
    'expected reuse-cli remote daemon smoke to probe remote auth status before forcing daemon start'
  );
  assert.match(
    reuseCliRaw,
    /auth request --json --persist/,
    'expected reuse-cli remote daemon smoke to request remote auth pairing when credentials are missing'
  );
  assert.match(
    reuseCliRaw,
    /auth approve --json --public-key/,
    'expected reuse-cli remote daemon smoke to approve remote auth request with local authenticated credentials'
  );
  assert.match(
    reuseCliRaw,
    /auth wait --public-key .*--json --persist/,
    'expected reuse-cli remote daemon smoke to wait for approved remote auth credentials before daemon start'
  );
  assert.match(
    reuseCliRaw,
    /ssh "\$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='\$selected_server_id'[^"]* daemon start"/,
    'expected reuse-cli remote daemon smoke to start remote daemon with explicit selected server scope to avoid default-profile drift'
  );
  assert.match(
    reuseCliRaw,
    /ssh "\$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='\$selected_server_id'[^"]* daemon status --json"/,
    'expected reuse-cli remote daemon smoke to query daemon status with explicit selected server scope'
  );
  assert.match(
    reuseCliRaw,
    /j\.daemon&&j\.daemon\.running===true/,
    'expected reuse-cli remote daemon smoke to treat daemon.running=true status payloads as healthy'
  );
  assert.match(
    reuseCliRaw,
    /tail -n 200 ['"]\$daemon_log_path['"]/,
    'expected reuse-cli remote daemon smoke to print remote daemon logs when daemon start fails'
  );
  assert.match(
    reuseCliRaw,
    /already registered a machine after setup; skipping manual start/,
    'expected reuse-cli remote daemon smoke to tolerate setup flows that already start/register the remote daemon'
  );

  const bootstrapPath = join(smokeDir, 'bin', 'remote-daemon-smoke.sh');
  const bootstrapRaw = await readFile(bootstrapPath, 'utf8');
  assert.doesNotMatch(
    bootstrapRaw,
    /retrying without --public-server-url compatibility flag/,
    'expected bootstrap remote daemon smoke to fail closed instead of retrying without --public-server-url'
  );
  assert.doesNotMatch(
    bootstrapRaw,
    /Unknown machine setup arguments: --public-server-url/,
    'expected bootstrap remote daemon smoke to avoid unsupported --public-server-url compatibility signatures'
  );
  assert.match(
    bootstrapRaw,
    /hstack remote daemon setup[\s\S]*--yes/,
    'expected bootstrap remote daemon setup to force --yes in non-interactive mode for SSH trust prompts'
  );
  assert.match(
    bootstrapRaw,
    /resolve_remote_happier_command\(\)/,
    'expected bootstrap remote daemon smoke to resolve the installed remote CLI shim dynamically'
  );
  assert.match(
    bootstrapRaw,
    /~\/\.happier\/bin\/h(prev|appier)/,
    'expected bootstrap remote daemon smoke to probe channel-specific managed shims on the remote host'
  );
  assert.match(
    bootstrapRaw,
    /~\/\.happier\/cli-preview\/current\/happier/,
    'expected bootstrap remote daemon smoke to probe installer-managed preview CLI payload paths when ~/.happier/bin is absent'
  );
  assert.doesNotMatch(
    bootstrapRaw,
    /ssh "\$REMOTE_SSH_TARGET" "~\/\.happier\/bin\/happier daemon start"/,
    'expected bootstrap remote daemon smoke to avoid hardcoding a stable-only remote CLI path'
  );
  assert.match(
    bootstrapRaw,
    /checking remote daemon connectivity after setup/,
    'expected bootstrap remote daemon smoke to verify machine registration after setup before forcing manual daemon start'
  );
  assert.match(
    bootstrapRaw,
    /auth status --json/,
    'expected bootstrap remote daemon smoke to probe remote auth status before forcing daemon start'
  );
  assert.match(
    bootstrapRaw,
    /auth request --json --persist/,
    'expected bootstrap remote daemon smoke to request remote auth pairing when credentials are missing'
  );
  assert.match(
    bootstrapRaw,
    /auth approve --json --public-key/,
    'expected bootstrap remote daemon smoke to approve remote auth request with local authenticated credentials'
  );
  assert.match(
    bootstrapRaw,
    /auth wait --public-key .*--json --persist/,
    'expected bootstrap remote daemon smoke to wait for approved remote auth credentials before daemon start'
  );
  assert.match(
    bootstrapRaw,
    /ssh "\$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='\$HAPPIER_ACTIVE_SERVER_ID'[^"]* daemon start"/,
    'expected bootstrap remote daemon smoke to start remote daemon with explicit active server scope to avoid default-profile drift'
  );
  assert.match(
    bootstrapRaw,
    /ssh "\$REMOTE_SSH_TARGET" "HAPPIER_ACTIVE_SERVER_ID='\$HAPPIER_ACTIVE_SERVER_ID'[^"]* daemon status --json"/,
    'expected bootstrap remote daemon smoke to query daemon status with explicit active server scope'
  );
  assert.match(
    bootstrapRaw,
    /j\.daemon&&j\.daemon\.running===true/,
    'expected bootstrap remote daemon smoke to treat daemon.running=true status payloads as healthy'
  );
  assert.match(
    bootstrapRaw,
    /tail -n 200 ['"]\$daemon_log_path['"]/,
    'expected bootstrap remote daemon smoke to print remote daemon logs when daemon start fails'
  );
  assert.match(
    bootstrapRaw,
    /already registered a machine after setup; skipping manual start/,
    'expected bootstrap remote daemon smoke to tolerate setup flows that already start/register the remote daemon'
  );
});
