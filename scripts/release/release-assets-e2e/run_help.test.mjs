import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const runScript = join(here, 'run.sh');

for (const scriptName of ['remote-daemon-smoke.sh', 'remote-daemon-authenticated-cli-smoke.sh']) {
  function runSetupCapture(result) {
    const source = fs.readFileSync(join(here, 'bin', scriptName), 'utf8');
    const start = source.indexOf('remote_setup_output="$(mktemp');
    // Exercise the real setup capture at the hstack process boundary, before
    // unrelated relay/SSH connectivity checks.
    const captureEnd = source.indexOf('checking remote daemon connectivity after setup...', start);
    const block = source.slice(start, source.lastIndexOf('\necho ', captureEnd));
    assert.ok(start >= 0 && captureEnd > start);
    return spawnSync('bash', ['-c', `set -euo pipefail
      hstack() { printf '%s\\n' "$HAPPIER_TEST_SETUP_RESULT"; }
      remote_channel_args=(--preview)
      ${block}`, join(here, 'bin', scriptName)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_TEST_SETUP_RESULT: result,
        REMOTE_SSH_TARGET: 'happy@remote1',
        HAPPIER_SERVER_URL: 'http://stack:3005',
        HAPPIER_WEBAPP_URL: 'http://stack:3005',
        HAPPIER_PUBLIC_SERVER_URL: 'http://stack:3005',
      },
    });
  }

  test(`${scriptName} rejects a failed JSON task result even when hstack exits successfully`, () => {
    const output = runSetupCapture([
      JSON.stringify({ protocolVersion: 1, taskId: 'private-task', type: 'progress', data: { token: 'private-token' } }),
      JSON.stringify({ protocolVersion: 1, taskId: 'private-task', ok: false, error: { code: 'DOWNLOAD_FAILED', message: 'Release download failed' } }),
    ].join('\n'));
    assert.equal(output.status, 1, output.stderr);
    assert.match(output.stderr, /DOWNLOAD_FAILED/);
    assert.doesNotMatch(output.stdout + output.stderr, /private-task|private-token/);
  });

  test(`${scriptName} accepts a successful JSON task result without disclosing its data`, () => {
    const output = runSetupCapture(JSON.stringify({ protocolVersion: 1, taskId: 'private-task', ok: true, data: { token: 'private-token' } }));
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout + output.stderr, '');
  });

  test(`${scriptName} rejects setup output without a terminal result`, () => {
    const output = runSetupCapture(JSON.stringify({ protocolVersion: 1, taskId: 'private-task', type: 'progress' }));
    assert.equal(output.status, 1, output.stderr);
    assert.match(output.stderr, /REMOTE_SETUP_RESULT_MISSING/);
  });
}

test('npm-e2e-smoke run.sh documents remote daemon flags', () => {
  const res = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout ?? '', /--with-remote-daemon/);
  assert.match(res.stdout ?? '', /--no-remote-daemon/);
  assert.match(res.stdout ?? '', /--remote-auth-mode=/);
  assert.match(res.stdout ?? '', /--with-remote-server/);
  assert.match(res.stdout ?? '', /--no-remote-server/);
  assert.match(res.stdout ?? '', /--remote-server-db=/);
});

test('npm-e2e-smoke run.sh supports selecting remote installer mode', () => {
  {
    const res = spawnSync('bash', [runScript, '--remote-installer=shim', '--help'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout ?? '', /--remote-installer=/);
  }
  {
    const res = spawnSync('bash', [runScript, '--remote-installer=official', '--help'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout ?? '', /--remote-installer=/);
  }
});

test('npm-e2e-smoke run.sh rejects invalid remote installer mode', () => {
  const res = spawnSync('bash', [runScript, '--remote-installer=wat', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /remote-installer/i);
});

test('npm-e2e-smoke run.sh rejects unknown args', () => {
  const res = spawnSync('bash', [runScript, '--definitely-not-a-flag'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /Unknown arg/i);
});

test('npm-e2e-smoke run.sh rejects invalid remote auth mode', () => {
  const res = spawnSync('bash', [runScript, '--remote-auth-mode=wat', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /remote-auth-mode/i);
});

test('npm-e2e-smoke run.sh rejects invalid remote server db mode', () => {
  const res = spawnSync('bash', [runScript, '--remote-server-db=wat', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /remote-server-db/i);
});

test('npm-e2e-smoke run.sh uses consistent compose files when remote daemon enabled', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /\bcompose_run=\(\s*\"\$\{compose_remote\[@\]\}\"\s*\)/);
  assert.match(content, /\$\{compose_run\[@\]\}.*run --rm --no-deps cli/);
  assert.match(content, /\$\{compose_run\[@\]\}.*run --rm --no-deps cli2/);
});

test('npm-e2e-smoke run.sh cleanup does not hang indefinitely', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /cleanup timed out/i);
 });

test('npm-e2e-smoke run.sh does not rebuild when starting remote host', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.doesNotMatch(content, /up -d[^\n]*--build[^\n]*remote1/);
});

test('npm-e2e-smoke run.sh prebuilds remote-daemon-authenticated-cli-smoke', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /build[^\n]*remote-daemon-authenticated-cli-smoke/);
});

test('npm-e2e-smoke run.sh can pack npm tarballs for remote-installer=shim', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /packing remote shim tarballs from npm/i);
  assert.match(content, /\bnpm\b[^\n]*\bpack\b[^\n]*"\$stack_spec"/);
  assert.match(content, /\bnpm\b[^\n]*\bpack\b[^\n]*"\$cli_spec"/);
});

test('npm-e2e-smoke includes remote server smoke scripts and postgres compose', () => {
  const composeRemotePath = join(here, 'compose.remote.yml');
  const composeRemote = fs.readFileSync(composeRemotePath, 'utf8');
  assert.match(composeRemote, /\n  postgres:\n/);
  assert.match(composeRemote, /\n  remote-server1:\n/);
  assert.match(composeRemote, /\n  remote-server-smoke:\n/);
  assert.ok(fs.existsSync(join(here, 'bin', 'remote-server-smoke.sh')));
});

test('npm-e2e-smoke remote smoke scripts pass bash -n', () => {
  const scripts = [
    join(here, 'bin', 'remote-daemon-smoke.sh'),
    join(here, 'bin', 'remote-daemon-authenticated-cli-smoke.sh'),
    join(here, 'bin', 'remote-server-smoke.sh'),
  ];
  for (const script of scripts) {
    const res = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
  }
});

test('npm-e2e-smoke remote-server-smoke.sh does not use an unterminated heredoc here-string', () => {
  const script = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.doesNotMatch(script, /\nNODE <<</);
});

test('npm-e2e-smoke remote-server-smoke.sh parses multi-line server.env output', () => {
  const script = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.match(script, /const raw = process\.env\.REMOTE_SERVER_CONFIG_ENV_TEXT \|\| '';/);
  assert.match(script, /for \(const line of raw\.split\(\/\\r\?\\n\/\)\)/);
  assert.match(script, /sudo -n cat .*remote_config_env_path/);
});

test('npm-e2e-smoke postgres validation asserts connectivity (pg_stat_activity) instead of table creation', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /POSTGRES_APP_NAME=/);
  assert.match(content, /pg_stat_activity/);
  assert.match(content, /application_name/);

  const remoteServerSmoke = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.match(remoteServerSmoke, /application_name=/);
});

test('npm-e2e-smoke run.sh documents docker image smoke flags', () => {
  const res = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout ?? '', /--with-docker-images/);
  assert.match(res.stdout ?? '', /--no-docker-images/);
  assert.match(res.stdout ?? '', /--docker-channel=/);
  assert.match(res.stdout ?? '', /--docker-images-db=/);
});

test('npm-e2e-smoke includes dockerhub compose and references published images', () => {
  const composePath = join(here, 'compose.dockerhub.yml');
  assert.ok(fs.existsSync(composePath));

  const compose = fs.readFileSync(composePath, 'utf8');
  assert.match(compose, /\n  relay:\n/);
  assert.match(compose, /HAPPIER_RELAY_IMAGE/);
  assert.match(compose, /HAPPIER_DEVBOX_IMAGE/);

  // Ensure the runner defaults target the published dockerhub repositories.
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /happierdev\/relay-server/);
  assert.match(content, /happierdev\/dev-box/);
});

test('npm-e2e-smoke cli-smoke.sh supports preinstalled happier-cli mode', () => {
  const cliSmoke = fs.readFileSync(join(here, 'bin', 'cli-smoke.sh'), 'utf8');
  assert.match(cliSmoke, /HAPPIER_CLI_INSTALL_MODE/);
  assert.match(cliSmoke, /preinstalled/);
  assert.match(cliSmoke, /command -v happier/);
});

test('release-assets-e2e remote host install shims make repeated CLI installs idempotent', () => {
  const entrypoints = [
    join(here, 'bin', 'remote-host-entrypoint.sh'),
    join(here, 'bin', 'remote-host-systemd-entrypoint.sh'),
  ];

  for (const entrypoint of entrypoints) {
    const script = fs.readFileSync(entrypoint, 'utf8');
    assert.match(script, /rm -f "\$prefix\/bin\/happier"/);
    assert.match(script, /npm install -g --force \/packs\/cli\.tgz --no-audit --no-fund/);
  }
});

test('systemd test hosts use Docker-private cgroup mounts, not the read-only host root', () => {
  const dockerfile = fs.readFileSync(join(here, 'Dockerfile.remote-host-systemd'), 'utf8');
  const compose = fs.readFileSync(join(here, 'compose.remote.yml'), 'utf8');
  assert.doesNotMatch(dockerfile, /^VOLUME\s+\["\/sys\/fs\/cgroup"\]/m);
  assert.doesNotMatch(compose, /- \/sys\/fs\/cgroup:\/sys\/fs\/cgroup/);
  assert.match(compose, /privileged: true/);
});

test('npm-e2e-smoke dockerhub postgres smoke waits for postgres readiness', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /waiting for dockerhub postgres/i);
  assert.match(content, /pg_isready/);
});

test('npm-e2e-smoke dockerhub images smoke preflights image availability', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /docker manifest inspect/);
});

test('release-assets-e2e run.sh documents relay-server upgrade smoke flags', () => {
  const res = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout ?? '', /--with-relay-upgrade/);
  assert.match(res.stdout ?? '', /--no-relay-upgrade/);
  assert.match(res.stdout ?? '', /--relay-upgrade-from-channel=/);
  assert.match(res.stdout ?? '', /--relay-upgrade-db=/);
  assert.match(res.stdout ?? '', /--relay-upgrade-to-server-tag=/);
  assert.match(res.stdout ?? '', /--relay-upgrade-to-server-version=/);
});

test('release-assets-e2e run.sh requires immutable relay upgrade tag and version together', () => {
  const res = spawnSync('bash', [runScript, '--relay-upgrade-to-server-tag=server-v0.2.11', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /tag and version must be provided together/i);
});

test('release-assets-e2e bootstraps relay auth in a Node-capable smoke container', () => {
  const composePath = join(here, 'compose.dockerhub.yml');
  const compose = YAML.parse(fs.readFileSync(composePath, 'utf8'));
  assert.match(compose.services['auth-bootstrap']?.image ?? '', /^node:22-/);
  assert.ok(compose.services['auth-bootstrap']?.volumes?.some((volume) => String(volume).includes(':/opt/happier-npm-e2e/bin:ro')));
  assert.equal(compose.services.relay?.volumes?.some((volume) => String(volume).includes(':/opt/happier-npm-e2e/bin:ro')), false);

  const script = fs.readFileSync(runScript, 'utf8');
  const upgradeBlock = script.slice(script.indexOf('run_relay_upgrade_smoke()'), script.indexOf('if [[ "$monorepo_mode" == "local" ]]'));
  assert.match(upgradeBlock, /run --rm -T --no-deps[^\n]*auth-bootstrap sh -lc/);
  assert.doesNotMatch(upgradeBlock, /exec -T relay node/);
});

test('release-assets-e2e run.sh cleanup does not crash when docker is unavailable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-release-assets-e2e-docker-down-test-'));
  const binDir = join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const dockerShim = join(binDir, 'docker');
  fs.writeFileSync(
    dockerShim,
    '#!/usr/bin/env sh\n' +
      'echo "docker shim: unavailable" >&2\n' +
      'exit 1\n',
    { encoding: 'utf8' }
  );
  fs.chmodSync(dockerShim, 0o755);

  const res = spawnSync('bash', [runScript, '--mode=npm', '--no-remote-daemon', '--no-remote-server', '--timeout-s=1'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });

  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stderr ?? '', /unbound variable/i);
});

test('release-assets-e2e run.sh surfaces npm pack output on failure', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-release-assets-e2e-npm-pack-fail-test-'));
  const binDir = join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const dockerShim = join(binDir, 'docker');
  fs.writeFileSync(dockerShim, '#!/usr/bin/env sh\nexit 0\n', { encoding: 'utf8' });
  fs.chmodSync(dockerShim, 0o755);

  const npmShim = join(binDir, 'npm');
  fs.writeFileSync(npmShim, '#!/usr/bin/env sh\necho \"npm shim: pack failed\"\nexit 2\n', { encoding: 'utf8' });
  fs.chmodSync(npmShim, 0o755);

  const res = spawnSync(
    'bash',
    [runScript, '--mode=local', '--no-remote-daemon', '--no-remote-server', '--timeout-s=1', '--keep'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    }
  );

  assert.equal(res.status, 2, res.stderr || res.stdout);
  assert.match(`${res.stdout ?? ''}\n${res.stderr ?? ''}`, /npm shim: pack failed/);
});
