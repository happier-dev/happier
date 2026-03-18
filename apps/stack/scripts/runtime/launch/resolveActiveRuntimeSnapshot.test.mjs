import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveActiveRuntimeSnapshot } from './resolveActiveRuntimeSnapshot.mjs';
import { resolveCliRuntimeLaunchSpec } from './resolveCliRuntimeLaunchSpec.mjs';
import { writeRuntimeManifest, writeRuntimePointer } from '../shared/runtime_manifest.mjs';
import { resolveStackRuntimePaths } from '../shared/runtime_paths.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-launch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('resolveActiveRuntimeSnapshot returns null in prefer mode when no snapshot is active', async (t) => {
  const root = await withTempRoot(t);

  const resolved = await resolveActiveRuntimeSnapshot({
    mode: 'prefer',
    stackBaseDir: root,
  });

  assert.equal(resolved, null);
});

test('resolveActiveRuntimeSnapshot rejects require mode when no snapshot is active', async (t) => {
  const root = await withTempRoot(t);

  await assert.rejects(
    async () => resolveActiveRuntimeSnapshot({ mode: 'require', stackBaseDir: root }),
    /missing active runtime snapshot/i,
  );
});

test('resolveActiveRuntimeSnapshot falls back to source in prefer mode when the active snapshot is invalid', async (t) => {
  const root = await withTempRoot(t);
  const paths = resolveStackRuntimePaths({ stackBaseDir: root, snapshotId: 'snap-bad' });
  await mkdir(paths.snapshotDir, { recursive: true });
  await writeRuntimeManifest({
    manifestPath: paths.manifestPath,
    manifest: {
      version: 1,
      snapshotId: 'snap-bad',
      sourceFingerprint: 'src-bad',
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
      },
    },
  });
  await writeRuntimePointer({
    currentPath: paths.currentPath,
    pointer: {
      version: 1,
      snapshotId: 'snap-bad',
      snapshotPath: paths.snapshotDir,
      sourceFingerprint: 'src-bad',
    },
  });

  const resolved = await resolveActiveRuntimeSnapshot({
    mode: 'prefer',
    stackBaseDir: root,
  });

  assert.equal(resolved, null);
});

test('resolveActiveRuntimeSnapshot rejects pointers that escape the stack runtime builds dir', async (t) => {
  const root = await withTempRoot(t);
  const paths = resolveStackRuntimePaths({ stackBaseDir: root, snapshotId: 'snap-1' });
  const escaped = await mkdtemp(join(tmpdir(), 'hstack-runtime-escaped-'));
  t.after(async () => {
    await rm(escaped, { recursive: true, force: true });
  });

  await mkdir(paths.snapshotDir, { recursive: true });
  await mkdir(join(escaped, 'ui'), { recursive: true });
  await mkdir(join(escaped, 'server'), { recursive: true });
  await mkdir(join(escaped, 'cli'), { recursive: true });
  await writeFile(join(escaped, 'ui', 'index.html'), '<html></html>\n', 'utf-8');
  await writeFile(join(escaped, 'server', 'happier-server'), 'echo server\n', 'utf-8');
  await writeFile(join(escaped, 'cli', 'happier'), 'echo cli\n', 'utf-8');
  await writeRuntimeManifest({
    manifestPath: paths.manifestPath,
    manifest: {
      version: 1,
      snapshotId: 'snap-1',
      sourceFingerprint: 'src-1',
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/happier' },
      },
    },
  });
  await writeRuntimePointer({
    currentPath: paths.currentPath,
    pointer: {
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: escaped,
      sourceFingerprint: 'src-1',
    },
  });

  await assert.rejects(
    async () => resolveActiveRuntimeSnapshot({ mode: 'require', stackBaseDir: root }),
    /outside the stack runtime builds dir/i,
  );
});

test('resolveActiveRuntimeSnapshot returns validated manifest and pointer data', async (t) => {
  const root = await withTempRoot(t);
  const paths = resolveStackRuntimePaths({ stackBaseDir: root, snapshotId: 'snap-1' });
  await mkdir(paths.snapshotDir, { recursive: true });
  await mkdir(join(paths.snapshotDir, 'ui'), { recursive: true });
  await mkdir(join(paths.snapshotDir, 'server', 'dist', 'runtime'), { recursive: true });
  await mkdir(join(paths.snapshotDir, 'cli', 'dist'), { recursive: true });
  await writeFile(join(paths.snapshotDir, 'ui', 'index.html'), '<html></html>\n', 'utf-8');
  await writeFile(join(paths.snapshotDir, 'server', 'dist', 'runtime', 'main.js'), 'export {};\n', 'utf-8');
  await writeFile(join(paths.snapshotDir, 'cli', 'dist', 'index.mjs'), 'export {};\n', 'utf-8');
  await writeRuntimeManifest({
    manifestPath: paths.manifestPath,
    manifest: {
      version: 1,
      snapshotId: 'snap-1',
      sourceFingerprint: 'src-1',
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/dist/runtime/main.js' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/dist/index.mjs' },
      },
    },
  });
  await writeRuntimePointer({
    currentPath: paths.currentPath,
    pointer: {
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: paths.snapshotDir,
      sourceFingerprint: 'src-1',
    },
  });

  const resolved = await resolveActiveRuntimeSnapshot({
    mode: 'require',
    stackBaseDir: root,
  });

  assert.equal(resolved.snapshotId, 'snap-1');
  assert.equal(resolved.snapshotPath, paths.snapshotDir);
  assert.equal(resolved.manifest.sourceFingerprint, 'src-1');
});

test('resolveActiveRuntimeSnapshot surfaces bundled workspace sync config from the runtime manifest source repo', async (t) => {
  const root = await withTempRoot(t);
  const repoRoot = join(root, 'repo');
  const helperPath = join(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
  const paths = resolveStackRuntimePaths({ stackBaseDir: root, snapshotId: 'snap-1' });
  await mkdir(join(repoRoot, 'scripts', 'workspaces'), { recursive: true });
  await writeFile(helperPath, 'export function syncBundledWorkspacePackages() {}\n', 'utf-8');
  await mkdir(paths.snapshotDir, { recursive: true });
  await mkdir(join(paths.snapshotDir, 'ui'), { recursive: true });
  await mkdir(join(paths.snapshotDir, 'server', 'dist', 'runtime'), { recursive: true });
  await mkdir(join(paths.snapshotDir, 'cli', 'package-dist'), { recursive: true });
  await writeFile(join(paths.snapshotDir, 'ui', 'index.html'), '<html></html>\n', 'utf-8');
  await writeFile(join(paths.snapshotDir, 'server', 'dist', 'runtime', 'main.js'), 'export {};\n', 'utf-8');
  await writeFile(join(paths.snapshotDir, 'cli', 'package-dist', 'index.mjs'), 'export {};\n', 'utf-8');
  await writeRuntimeManifest({
    manifestPath: paths.manifestPath,
    manifest: {
      version: 1,
      snapshotId: 'snap-1',
      sourceFingerprint: 'src-1',
      source: {
        repoDir: repoRoot,
      },
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/dist/runtime/main.js' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: 'cli/package-dist/index.mjs' },
      },
    },
  });
  await writeRuntimePointer({
    currentPath: paths.currentPath,
    pointer: {
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: paths.snapshotDir,
      sourceFingerprint: 'src-1',
    },
  });

  const resolved = await resolveActiveRuntimeSnapshot({
    mode: 'require',
    stackBaseDir: root,
  });

  assert.deepEqual(resolved.bundledWorkspaceSync, {
    repoRoot,
    helperPath,
    targetPackageRoot: join(paths.snapshotDir, 'cli'),
  });
});

test('resolveCliRuntimeLaunchSpec carries bundled workspace sync metadata for runtime callers', () => {
  const resolved = resolveCliRuntimeLaunchSpec({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        source: {
          repoDir: '/repo',
        },
        components: {
          daemon: { entrypoint: 'cli/package-dist/index.mjs' },
        },
      },
      bundledWorkspaceSync: {
        repoRoot: '/repo',
        helperPath: '/repo/scripts/workspaces/syncBundledWorkspacePackages.mjs',
        targetPackageRoot: '/tmp/stack/runtime/builds/snap-1/cli',
      },
    },
  });

  assert.deepEqual(resolved.bundledWorkspaceSync, {
    repoRoot: '/repo',
    helperPath: '/repo/scripts/workspaces/syncBundledWorkspacePackages.mjs',
    targetPackageRoot: '/tmp/stack/runtime/builds/snap-1/cli',
  });
});
