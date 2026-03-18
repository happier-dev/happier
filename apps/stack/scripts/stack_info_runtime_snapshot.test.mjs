import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';

test('readStackInfoSnapshot reports active runtime snapshot metadata', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });

  const prevStorage = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = fixture.storageDir;
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, fixture.snapshotDir);
    assert.equal(out.runtime.valid, true);
    assert.equal(out.runtime.snapshotComponents.server.entrypoint, 'server/happier-server');
  } finally {
    if (typeof prevStorage === 'undefined') {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    } else {
      process.env.HAPPIER_STACK_STORAGE_DIR = prevStorage;
    }
  }
});

test('readStackInfoSnapshot reports invalid runtime pointers instead of marking them valid', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
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

  const prevStorage = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = fixture.storageDir;
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, join(fixture.root, 'escaped-runtime'));
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('\n'), /outside the stack runtime builds dir/i);
  } finally {
    if (typeof prevStorage === 'undefined') {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    } else {
      process.env.HAPPIER_STACK_STORAGE_DIR = prevStorage;
    }
  }
});

test('readStackInfoSnapshot reports runtime snapshots with missing daemon node entrypoints as invalid', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  await rm(join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'), { force: true });
  await rm(join(fixture.stackDir, 'runtime', 'current', 'cli', 'package-dist', 'index.mjs'), { force: true });

  const prevStorage = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = fixture.storageDir;
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, fixture.snapshotDir);
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('\n'), /missing daemon node entrypoint/i);
  } finally {
    if (typeof prevStorage === 'undefined') {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    } else {
      process.env.HAPPIER_STACK_STORAGE_DIR = prevStorage;
    }
  }
});
