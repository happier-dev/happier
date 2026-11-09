import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { inspectRetiredWorkspaceReplicationState } from './workspaceSyncLegacyState';

describe('retired workspace state diagnostic', () => {
  it('reports absence without creating a predecessor directory', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'WS-LEGACY-absent-'));
    onTestFinished(async () => await rm(activeServerDir, { recursive: true, force: true }));
    await expect(inspectRetiredWorkspaceReplicationState({ activeServerDir })).resolves.toEqual({ status: 'absent' });
    expect(await readdir(activeServerDir)).toEqual([]);
  });

  it('reports opaque predecessor bytes without classifying, renaming or changing permissions', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'WS-LEGACY-preserved-'));
    onTestFinished(async () => await rm(activeServerDir, { recursive: true, force: true }));
    const path = join(activeServerDir, 'workspace-replication');
    await mkdir(path, { mode: 0o755 });
    const opaque = Buffer.from([0, 255, 128, 42]);
    await writeFile(join(path, 'unknown-shape'), opaque);
    const before = await lstat(path);
    await expect(inspectRetiredWorkspaceReplicationState({ activeServerDir }))
      .resolves.toEqual({ status: 'preserved', path });
    expect(await readFile(join(path, 'unknown-shape'))).toEqual(opaque);
    expect((await lstat(path)).mode).toBe(before.mode);
    expect(await readdir(activeServerDir)).toEqual(['workspace-replication']);
    expect(await readdir(path)).toEqual(['unknown-shape']);
  });

  it.skipIf(process.platform === 'win32')('names a symlink without traversing or changing its target', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'WS-LEGACY-symlink-'));
    onTestFinished(async () => await rm(activeServerDir, { recursive: true, force: true }));
    const path = join(activeServerDir, 'workspace-replication');
    // A dangling link is still preserved state: the diagnostic must not follow it.
    await symlink(join(activeServerDir, 'absent-target'), path);
    await expect(inspectRetiredWorkspaceReplicationState({ activeServerDir }))
      .resolves.toEqual({ status: 'preserved', path });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readdir(activeServerDir)).toEqual(['workspace-replication']);
  });
});
