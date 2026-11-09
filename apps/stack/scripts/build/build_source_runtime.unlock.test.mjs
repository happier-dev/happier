import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { rmSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { setBundleReadOnly } from './build_source_runtime.mjs';

// A concurrent producer can remove part of a bundle after it is listed. Unlocking only prepares the
// tree for deletion, so a vanished entry needs no permission change; locking still fails closed.
function makeWritableSync(path) {
  fs.chmodSync(path, 0o755);
  for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeWritableSync(child);
    else fs.chmodSync(child, 0o644);
  }
}

async function withEntryRemovedAfterListing(t, root, removed, action) {
  const realReaddir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', async (path, ...args) => {
    const entries = await realReaddir(path, ...args);
    if (String(path) === root) {
      // The concurrent producer owns its own permissions; model that by unlocking only the removed subtree.
      const rootMode = fs.statSync(root).mode & 0o777;
      fs.chmodSync(root, 0o755);
      makeWritableSync(removed);
      rmSync(removed, { recursive: true, force: true });
      fs.chmodSync(root, rootMode);
    }
    return entries;
  });
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

async function bundleFixture(t) {
  const fixture = await createTempFixture(t, {
    prefix: 'hstack-bundle-unlock-',
    registerCleanup: false,
  });
  const root = fixture.path('runtime');
  const gone = join(root, 'packages');
  await mkdir(join(gone, 'agents', 'dist'), { recursive: true });
  await writeFile(join(gone, 'agents', 'dist', 'index.js'), 'export {};\n');
  await mkdir(join(root, 'apps'), { recursive: true });
  await writeFile(join(root, 'apps', 'main.js'), 'export {};\n');
  t.after(async () => {
    await setBundleReadOnly(root, false).catch(() => {});
    await fixture.cleanup();
  });
  return { root, gone };
}

test('unlocking a bundle for deletion tolerates entries removed concurrently', async (t) => {
  const { root, gone } = await bundleFixture(t);
  await setBundleReadOnly(root, true);
  await withEntryRemovedAfterListing(t, root, gone, () =>
    setBundleReadOnly(root, false),
  );
  await rm(root, { recursive: true, force: true });
  await assert.rejects(readdir(root), { code: 'ENOENT' });
});

test('locking a bundle read-only still fails when an entry vanishes', async (t) => {
  const { root, gone } = await bundleFixture(t);
  await assert.rejects(
    withEntryRemovedAfterListing(t, root, gone, () =>
      setBundleReadOnly(root, true),
    ),
    { code: 'ENOENT' },
  );
});
