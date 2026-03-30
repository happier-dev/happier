import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('configuration workspace replication blob pack sizing', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES',
    'HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS',
    'HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  const tempDirs: string[] = [];

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      removeTempDirSync(tempDir);
    }
    tempDirs.length = 0;
  });

  it('defaults workspace replication blob pack sizing to Appendix A values', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES;
    delete process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS;
    delete process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.workspaceReplicationBlobPackTargetBytes).toBe(128 * 1024 * 1024);
    expect(configMod.configuration.workspaceReplicationBlobPackMaxBlobs).toBe(256);
    expect(configMod.configuration.workspaceReplicationBlobPackMaxSingleBlobBytes).toBe(1024 * 1024 * 1024);
  });

  it('reads workspace replication blob pack sizing from env through configuration.ts only', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = '4194304';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '64';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = '16777216';

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.workspaceReplicationBlobPackTargetBytes).toBe(4 * 1024 * 1024);
    expect(configMod.configuration.workspaceReplicationBlobPackMaxBlobs).toBe(64);
    expect(configMod.configuration.workspaceReplicationBlobPackMaxSingleBlobBytes).toBe(16 * 1024 * 1024);
  });

  it('clamps workspace replication blob pack sizing to defensive maximums', async () => {
    const homeDir = createTempDirSync('happier-cli-config-');
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_TARGET_BYTES = String(10 * 1024 * 1024 * 1024);
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_BLOBS = '99999999';
    process.env.HAPPIER_WORKSPACE_REPLICATION_BLOB_PACK_MAX_SINGLE_BLOB_BYTES = String(100 * 1024 * 1024 * 1024);

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();

    expect(configMod.configuration.workspaceReplicationBlobPackTargetBytes).toBe(1024 * 1024 * 1024);
    // Keep the hard ceiling small enough that server-routed blob-pack requests can carry digest lists
    // in the bounded `openPayload` envelope without exceeding hard caps (64KiB today).
    expect(configMod.configuration.workspaceReplicationBlobPackMaxBlobs).toBe(768);
    expect(configMod.configuration.workspaceReplicationBlobPackMaxSingleBlobBytes).toBe(4 * 1024 * 1024 * 1024);
  });
});
