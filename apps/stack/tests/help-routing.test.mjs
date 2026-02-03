import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function runHstack(args) {
  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(testDir, '..', '..', '..');
  const hstackBin = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
    },
    encoding: 'utf8',
  });
}

test('hstack stack -h prints stack root help', () => {
  const res = runHstack(['stack', '-h']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /\[stack\] usage:/);
  assert.ok(res.stdout.includes('hstack stack build <name>'));
  assert.ok(res.stdout.includes('hstack stack new <name>'));
});

test('hstack stack build -h prints build help (not root help)', () => {
  const res = runHstack(['stack', 'build', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack stack build <name>'));
  // Underlying build flags should be visible.
  assert.ok(res.stdout.includes('--tauri'));
  assert.ok(!res.stdout.includes('hstack stack new <name>'));
});

test('hstack stack build <stack> -h prints build help (not root help)', () => {
  const res = runHstack(['stack', 'build', 'dev', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack stack build <name>'));
  assert.ok(res.stdout.includes('--tauri'));
  assert.ok(!res.stdout.includes('hstack stack new <name>'));
});

test('hstack wt new -h prints new help (not root help)', () => {
  const res = runHstack(['wt', 'new', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack wt new <slug>'));
  assert.ok(!res.stdout.includes('hstack wt sync'));
});

test('hstack auth login -h prints login help (not root help)', () => {
  const res = runHstack(['auth', 'login', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack auth login'));
  assert.ok(!res.stdout.includes('hstack auth status'));
});

test('hstack tailscale enable -h prints enable help (not root help)', () => {
  const res = runHstack(['tailscale', 'enable', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack tailscale enable'));
  assert.ok(!res.stdout.includes('hstack tailscale status'));
});

test('hstack service status -h prints status help (not root help)', () => {
  const res = runHstack(['service', 'status', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack service status'));
  assert.ok(!res.stdout.includes('hstack service install|uninstall'));
});

test('hstack srv use -h prints use help (not root help)', () => {
  const res = runHstack(['srv', 'use', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack srv use <happier-server-light|happier-server>'));
  assert.ok(!res.stdout.includes('hstack srv status'));
});

test('hstack completion install -h prints install help (not root help)', () => {
  const res = runHstack(['completion', 'install', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack completion install'));
  assert.ok(!res.stdout.includes('hstack completion print'));
});

test('hstack self check -h prints check help (not root help)', () => {
  const res = runHstack(['self', 'check', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack self check'));
  assert.ok(!res.stdout.includes('hstack self status'));
});

test('hstack contrib sync -h prints sync help (not root help)', () => {
  const res = runHstack(['contrib', 'sync', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack contrib sync'));
  assert.ok(!res.stdout.includes('hstack contrib status'));
});

test('hstack menubar install -h prints install help (not root help)', () => {
  const res = runHstack(['menubar', 'install', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack menubar install'));
  assert.ok(!res.stdout.includes('hstack menubar uninstall'));
});

test('hstack monorepo port status -h prints status help (not root help)', () => {
  const res = runHstack(['monorepo', 'port', 'status', '-h']);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('hstack monorepo port status'));
  assert.ok(!res.stdout.includes('hstack monorepo port guide'));
});
