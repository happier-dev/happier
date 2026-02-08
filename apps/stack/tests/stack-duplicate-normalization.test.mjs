import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempDir } from './tempdir.test_helper.mjs';

function runHstack(args, { cwd, env }) {
  const testDir = resolve(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = resolve(testDir, '..', '..', '..');
  const hstackBin = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: cwd ?? repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('hstack stack duplicate normalizes the destination stack name', (t) => {
  const sandbox = createTempDir(t, 'hstack-sandbox-');
  const monoRoot = join(sandbox, 'mono');
  mkdirSync(monoRoot, { recursive: true });

  const fromStack = 'from';
  const fromEnvPath = join(sandbox, 'storage', fromStack, 'env');
  mkdirSync(dirname(fromEnvPath), { recursive: true });
  writeFileSync(fromEnvPath, `HAPPIER_STACK_REPO_DIR=${monoRoot}\n`, 'utf8');

  const res = runHstack(
    ['--sandbox-dir', sandbox, 'stack', 'duplicate', fromStack, 'MyStack', '--json'],
    { cwd: null, env: {} },
  );

  assert.equal(res.status, 0, `expected exit 0\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  let parsed;
  try {
    const start = res.stdout.indexOf('{');
    assert.ok(start >= 0, `expected JSON in stdout\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    parsed = JSON.parse(res.stdout.slice(start));
  } catch (e) {
    throw new Error(`stdout was not valid JSON.\nerror: ${String(e?.message ?? e)}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }

  assert.equal(parsed?.ok, true, `expected ok=true, got:\n${JSON.stringify(parsed, null, 2)}\n\nstderr:\n${res.stderr}`);
  assert.equal(parsed?.to, 'mystack');
  assert.ok(String(parsed?.envPath ?? '').includes(`${join('storage', 'mystack', 'env')}`));
});

test('hstack stack duplicate collapses punctuation and separators in destination name', (t) => {
  const sandbox = createTempDir(t, 'hstack-sandbox-');
  const monoRoot = join(sandbox, 'mono');
  mkdirSync(monoRoot, { recursive: true });

  const fromStack = 'from';
  const fromEnvPath = join(sandbox, 'storage', fromStack, 'env');
  mkdirSync(dirname(fromEnvPath), { recursive: true });
  writeFileSync(fromEnvPath, `HAPPIER_STACK_REPO_DIR=${monoRoot}\n`, 'utf8');

  const res = runHstack(
    ['--sandbox-dir', sandbox, 'stack', 'duplicate', fromStack, '...My__Stack 2026!!!', '--json'],
    { cwd: null, env: {} },
  );

  assert.equal(res.status, 0, `expected exit 0\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const start = res.stdout.indexOf('{');
  assert.ok(start >= 0, `expected JSON in stdout\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout.slice(start));
  } catch (e) {
    throw new Error(`stdout was not valid JSON.\nerror: ${String(e?.message ?? e)}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  assert.equal(parsed?.ok, true, `expected ok=true, got:\n${JSON.stringify(parsed, null, 2)}\n\nstderr:\n${res.stderr}`);
  assert.equal(parsed?.to, 'my-stack-2026');
  assert.ok(String(parsed?.envPath ?? '').includes(`${join('storage', 'my-stack-2026', 'env')}`));
});
