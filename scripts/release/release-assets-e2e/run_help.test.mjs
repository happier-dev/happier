import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runScript = join(here, 'run.sh');

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

test('npm-e2e-smoke remote-server-smoke.sh parses multi-line JSON output from config view', () => {
  const script = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.match(script, /JSON\.parse\(raw\)/);
  assert.doesNotMatch(script, /raw\.split\(/);
  assert.match(script, /self-host config view[^\n]*--mode=system/);
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

test('npm-e2e-smoke dockerhub postgres smoke waits for postgres readiness', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /waiting for dockerhub postgres/i);
  assert.match(content, /pg_isready/);
});

test('npm-e2e-smoke dockerhub images smoke preflights image availability', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /docker manifest inspect/);
});
