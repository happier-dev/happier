import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inspectRetiredWorkspaceReplicationState } from './workspaceSyncLegacyState';

async function makeServerDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'happier-workspace-sync-legacy-state-'));
}

describe('inspectRetiredWorkspaceReplicationState', () => {
  it('reports an absent legacy state root without creating anything', async () => {
    const activeServerDir = await makeServerDir();

    await expect(inspectRetiredWorkspaceReplicationState({
      activeServerDir,
      installationId: 'installation-test',
      nowMs: 1_700_000_000_000,
      randomSuffix: 'abc123',
    })).resolves.toEqual({
      status: 'absent',
      path: join(activeServerDir, 'workspace-replication'),
    });

    await rm(activeServerDir, { recursive: true, force: true });
  });

  it('quarantines an exact, owned v1 state root and writes a bounded retirement marker', async () => {
    const activeServerDir = await makeServerDir();
    const stateRoot = join(activeServerDir, 'workspace-replication');
    await mkdir(join(stateRoot, 'cas'), { recursive: true });
    await mkdir(join(stateRoot, 'jobs'));
    await writeFile(join(stateRoot, 'jobs', 'job-1.json'), JSON.stringify({ schemaVersion: 1, jobId: 'job-1' }));
    await chmod(stateRoot, 0o700);

    const result = await inspectRetiredWorkspaceReplicationState({
      activeServerDir,
      installationId: 'installation-test',
      nowMs: 1_700_000_000_000,
      randomSuffix: 'abc123',
    });

    const quarantinePath = join(activeServerDir, 'workspace-replication.retired-v1-1700000000000-abc123');
    expect(result).toMatchObject({
      status: 'legacy_workspace_sync_state_unsupported',
      classification: 'retired_v1',
      schemaVersion: 1,
      quarantinePath,
    });
    await expect(stat(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const marker = JSON.parse(await readFile(join(quarantinePath, 'retirement.json'), 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({
      detectedSchemaVersion: 1,
      detectedAtMs: 1_700_000_000_000,
      installationId: 'installation-test',
    });
    expect(typeof marker.inventoryHash).toBe('string');
    expect((await stat(quarantinePath)).mode & 0o777).toBe(0o700);

    await rm(activeServerDir, { recursive: true, force: true });
  });

  it('leaves a state root untouched when an unknown immediate child is present', async () => {
    const activeServerDir = await makeServerDir();
    const stateRoot = join(activeServerDir, 'workspace-replication');
    await mkdir(join(stateRoot, 'jobs'), { recursive: true });
    await writeFile(join(stateRoot, 'jobs', 'job-1.json'), JSON.stringify({ schemaVersion: 1 }));
    await writeFile(join(stateRoot, 'unexpected.txt'), 'do not touch');

    await expect(inspectRetiredWorkspaceReplicationState({
      activeServerDir,
      installationId: 'installation-test',
    })).resolves.toMatchObject({ status: 'legacy_workspace_sync_state_unknown' });
    await expect(readFile(join(stateRoot, 'unexpected.txt'), 'utf8')).resolves.toBe('do not touch');
    await expect(readdir(activeServerDir)).resolves.toContain('workspace-replication');

    await rm(activeServerDir, { recursive: true, force: true });
  });

  it('fails closed when the state root is group/other writable', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
    const activeServerDir = await makeServerDir();
    const stateRoot = join(activeServerDir, 'workspace-replication');
    await mkdir(join(stateRoot, 'jobs'), { recursive: true });
    await writeFile(join(stateRoot, 'jobs', 'job-1.json'), JSON.stringify({ schemaVersion: 1 }));
    await chmod(stateRoot, 0o777);

    await expect(inspectRetiredWorkspaceReplicationState({
      activeServerDir,
      installationId: 'installation-test',
    })).resolves.toMatchObject({ status: 'legacy_workspace_sync_state_unknown' });
    await expect(stat(stateRoot)).resolves.toBeTruthy();

    await rm(activeServerDir, { recursive: true, force: true });
  });
});
