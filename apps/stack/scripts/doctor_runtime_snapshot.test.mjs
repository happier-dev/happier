import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('doctor --json reports the active runtime snapshot', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.activeSnapshotId, 'snap-1');
  assert.equal(parsed.runtime.snapshotPath, fixture.snapshotDir);
  assert.equal(parsed.runtime.mode, 'prefer');
  assert.equal(parsed.uiBuildDir, join(fixture.snapshotDir, 'ui'));
  assert.notEqual(parsed.uiBuildDir, join(fixture.stackDir, 'runtime', 'current', 'ui'));
  assert.equal(parsed.checks.uiBuildDir?.ok, true);
  assert.equal(parsed.checks.uiBuildDir?.path, join(fixture.snapshotDir, 'ui'));
});

test('doctor --json reports source mode when no runtime snapshot is active', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'source',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.mode, 'source');
  assert.equal(parsed.runtime.activeSnapshotId, null);
  assert.equal(parsed.runtime.snapshotPath, null);
  assert.equal(parsed.runtime.valid, false);
  assert.equal(parsed.uiBuildDir, join(fixture.stackDir, 'ui'));
});

test('stack doctor --json diagnoses a source stack even when caller requires runtime snapshots', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await rm(join(fixture.stackDir, 'runtime', 'current.json'), { force: true });

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
  };

  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'doctor', fixture.stackName, '--json'], {
    cwd: rootDir,
    env,
  });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.mode, 'source');
  assert.equal(parsed.runtime.activeSnapshotId, null);
  assert.equal(parsed.runtime.snapshotPath, null);
});

test('doctor --json reports invalid active runtime snapshots even in prefer mode', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);
  await writeFile(
    join(fixture.stackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: join(fixture.root, 'escaped-runtime'),
      sourceFingerprint: 'src-1',
    }, null, 2) + '\n',
    'utf-8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
    HAPPIER_STACK_RUNTIME_MODE: 'prefer',
  };

  const res = await runNode([join(rootDir, 'scripts', 'doctor.mjs'), '--json'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.runtime.activeSnapshotId, 'snap-1');
  assert.equal(parsed.runtime.snapshotPath, join(fixture.root, 'escaped-runtime'));
  assert.equal(parsed.runtime.valid, false);
  assert.match(parsed.runtime.errors.join('\n'), /outside the stack runtime builds dir/i);
});
