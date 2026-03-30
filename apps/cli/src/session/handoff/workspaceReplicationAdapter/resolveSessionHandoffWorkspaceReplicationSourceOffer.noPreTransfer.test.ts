import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MachineTransferChannel } from '@/machines/transfer/serverRoutedTransport';
import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { resolveSessionHandoffWorkspaceReplicationSourceOffer } from './sessionHandoffWorkspaceReplicationAdapter';

describe('resolveSessionHandoffWorkspaceReplicationSourceOffer (no pre-transfer)', () => {
  it('server_routed_stream returns null when no pre-transferred metadata is available', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-offer-no-pretransfer-'));
    try {
      const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const manifest: WorkspaceManifest = {
        entries: [
          {
            kind: 'file',
            relativePath: 'README.md',
            digest,
            sizeBytes: 1,
            executable: false,
          },
        ],
      };
      const offer = {
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        manifest,
        blobIndex: [{ digest, sizeBytes: 1 }],
      };

      const machineTransferChannel: MachineTransferChannel = {
        onEnvelope: () => () => {},
        sendEnvelope: () => {},
      };

      const transfers: WorkspaceReplicationTransfers = {
        requestDirectPeerSourceOffer: async () => {
          throw new Error('unexpected direct-peer source-offer request');
        },
        requestServerRoutedSourceOffer: async () => offer,
        publishDirectPeerBlobPack: () => [],
        requestDirectPeerBlobPackToFile: async () => {
          throw new Error('unexpected direct-peer blob-pack request during source-offer resolution');
        },
        requestServerRoutedBlobPackToFile: async () => {
          throw new Error('unexpected server-routed blob-pack request during source-offer resolution');
        },
      };

      const resolved = await resolveSessionHandoffWorkspaceReplicationSourceOffer({
        activeServerDir,
        actualTransportStrategy: 'server_routed_stream',
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: '/target',
        metadata: undefined,
        machineTransferChannel,
        transfers,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
      });

      expect(resolved).toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('direct_peer resolves the source offer without requesting blob packs', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-offer-no-pretransfer-'));
    try {
      const digest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

      const transfers: WorkspaceReplicationTransfers = {
        requestDirectPeerSourceOffer: async () => {
          throw new Error('unexpected direct-peer source-offer request');
        },
        requestServerRoutedSourceOffer: async () => {
          throw new Error('unexpected server-routed source-offer request');
        },
        publishDirectPeerBlobPack: () => [],
        requestDirectPeerBlobPackToFile: async () => {
          throw new Error('unexpected direct-peer blob-pack request during source-offer resolution');
        },
        requestServerRoutedBlobPackToFile: async () => {
          throw new Error('unexpected server-routed blob-pack request during source-offer resolution');
        },
      };

      const resolved = await resolveSessionHandoffWorkspaceReplicationSourceOffer({
        activeServerDir,
        actualTransportStrategy: 'direct_peer',
        handoffId: 'handoff_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: '/target',
        metadata: {
          sourceRootPath: '/source',
          manifest: {
            entries: [
              {
                kind: 'file',
                relativePath: 'README.md',
                digest,
                sizeBytes: 1,
                executable: false,
              },
            ],
          },
        },
        transfers,
        blobPackTargetBytes: 1024,
        blobPackMaxBlobs: 10,
        blobPackMaxSingleBlobBytes: 1024 * 1024,
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.blobIndex).toEqual([{ digest, sizeBytes: 1 }]);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
