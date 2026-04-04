import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';

import { prepareSessionHandoffWorkspaceTarget } from './sessionHandoffWorkspaceReplicationAdapter';

describe('prepareSessionHandoffWorkspaceTarget (manifest loading)', () => {
  it('fails closed when workspace transfer is enabled but no source offer can be resolved', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-adapter-manifest-'));

    try {
      const workspaceTransfer: SessionHandoffWorkspaceTransfer = {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      };
      const transfers: WorkspaceReplicationTransfers = {
        requestDirectPeerSourceOffer: async () => {
          throw new Error('Unexpected direct-peer source-offer request');
        },
        requestServerRoutedSourceOffer: async () => {
          throw new Error('Unexpected server-routed source-offer request');
        },
        publishDirectPeerBlobPack: () => [],
        requestDirectPeerBlobPackToFile: async () => {
          throw new Error('Unexpected direct-peer blob-pack request');
        },
        requestServerRoutedBlobPackToFile: async () => {
          throw new Error('Unexpected server-routed blob-pack request');
        },
      };

      await expect(prepareSessionHandoffWorkspaceTarget({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_manifest_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: '/target',
        workspaceTransfer,
        transfers,
        blobPackTargetBytes: 1,
        blobPackMaxBlobs: 1,
        blobPackMaxSingleBlobBytes: 1,
      })).rejects.toThrow('Missing workspace replication source offer');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
