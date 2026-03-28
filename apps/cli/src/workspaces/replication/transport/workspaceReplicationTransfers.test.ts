import { describe, expect, it, vi } from 'vitest';

import type { TransferEndpointCandidate } from '@happier-dev/protocol';

describe('workspaceReplicationTransfers', () => {
  it('requests source offers through file-backed transfer APIs and decodes them from the on-disk format', async () => {
    const requestDirectPeerTransferToFile = vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({
      destinationPath,
      manifestHash: 'sha256:offer_direct_peer',
      sizeBytes: 12,
    }));
    const requestServerRoutedTransferToFile = vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({
      destinationPath,
      manifestHash: 'sha256:offer_server_routed',
      sizeBytes: 34,
    }));
    const readWorkspaceReplicationSourceOfferFromFile = vi.fn(async ({ transferId }: { transferId: string }) => {
      return transferId === 'offer_transfer_direct'
        ? {
            offerId: 'offer_direct_peer',
            relationshipId: 'relationship_123',
            directionId: 'direction_123',
            sourceFingerprint: 'sha256:manifest_123',
            manifest: {
              entries: [],
              fingerprint: 'sha256:manifest_123',
            },
            blobIndex: [],
          }
        : {
            offerId: 'offer_server_routed',
            relationshipId: 'relationship_456',
            directionId: 'direction_456',
            sourceFingerprint: 'sha256:manifest_456',
            manifest: {
              entries: [],
              fingerprint: 'sha256:manifest_456',
            },
            blobIndex: [],
          };
    });

    const { createWorkspaceReplicationTransfers } = await import('./workspaceReplicationTransfers');
    const transfers = createWorkspaceReplicationTransfers({
      requestDirectPeerTransferToFile,
      requestServerRoutedTransferToFile,
      readWorkspaceReplicationSourceOfferFromFile,
    });

    await expect(transfers.requestDirectPeerSourceOffer({
      transferId: 'offer_transfer_direct',
      endpointCandidates: [],
    })).resolves.toEqual({
      offerId: 'offer_direct_peer',
      relationshipId: 'relationship_123',
      directionId: 'direction_123',
      sourceFingerprint: 'sha256:manifest_123',
      manifest: {
        entries: [],
        fingerprint: 'sha256:manifest_123',
      },
      blobIndex: [],
    });
    expect(requestDirectPeerTransferToFile).toHaveBeenCalledWith({
      transferId: 'offer_transfer_direct',
      endpointCandidates: [],
      destinationPath: expect.any(String),
    });
    expect(readWorkspaceReplicationSourceOfferFromFile).toHaveBeenCalledWith({
      transferId: 'offer_transfer_direct',
      filePath: expect.any(String),
    });

    await expect(transfers.requestServerRoutedSourceOffer({
      transferId: 'offer_transfer_server',
      sourceMachineId: 'machine_source',
      machineTransferChannel: {
        onEnvelope: () => () => undefined,
        sendEnvelope: () => undefined,
      },
    })).resolves.toEqual({
      offerId: 'offer_server_routed',
      relationshipId: 'relationship_456',
      directionId: 'direction_456',
      sourceFingerprint: 'sha256:manifest_456',
      manifest: {
        entries: [],
        fingerprint: 'sha256:manifest_456',
      },
      blobIndex: [],
    });
    expect(requestServerRoutedTransferToFile).toHaveBeenCalledWith({
      transferId: 'offer_transfer_server',
      sourceMachineId: 'machine_source',
      machineTransferChannel: {
        onEnvelope: expect.any(Function),
        sendEnvelope: expect.any(Function),
      },
      destinationPath: expect.any(String),
    });
    expect(readWorkspaceReplicationSourceOfferFromFile).toHaveBeenCalledWith({
      transferId: 'offer_transfer_server',
      filePath: expect.any(String),
    });
  });

  it('publishes and requests blob packs through file-backed transfer APIs', async () => {
    const requestDirectPeerTransferToFile = vi.fn(async () => ({
      destinationPath: '/tmp/blob-pack.bin',
      manifestHash: 'sha256:pack_123',
      sizeBytes: 12,
    }));
    const requestServerRoutedTransferToFile = vi.fn(async () => ({
      destinationPath: '/tmp/blob-pack.bin',
      manifestHash: 'sha256:pack_123',
      sizeBytes: 12,
    }));
    const publishTransfer = vi.fn(() => [{
      kind: 'http' as const,
      url: 'http://127.0.0.1:46001/machine-transfers/direct/blob-pack',
      authorizationToken: 'token',
      expiresAt: 1,
    }]);
    const { createWorkspaceReplicationTransfers } = await import('./workspaceReplicationTransfers');
    const transfers = createWorkspaceReplicationTransfers({
      requestDirectPeerTransferToFile,
      requestServerRoutedTransferToFile,
    });

    expect(transfers.publishDirectPeerBlobPack({
      transferId: 'blob_pack_transfer_123',
      payloadSource: {
        kind: 'file',
        filePath: '/tmp/blob-pack.bin',
        sizeBytes: 12,
        manifestHash: 'sha256:pack_123',
      },
      directPeerTransfer: {
        publishTransfer,
      },
    })).toEqual([
      {
        kind: 'http',
        url: 'http://127.0.0.1:46001/machine-transfers/direct/blob-pack',
        authorizationToken: 'token',
        expiresAt: 1,
      },
    ]);
    expect(publishTransfer).toHaveBeenCalledWith({
      transferId: 'blob_pack_transfer_123',
      payloadSource: {
        kind: 'file',
        filePath: '/tmp/blob-pack.bin',
        sizeBytes: 12,
        manifestHash: 'sha256:pack_123',
      },
    });

    await expect(transfers.requestDirectPeerBlobPackToFile({
      transferId: 'blob_pack_transfer_123',
      endpointCandidates: [],
      destinationPath: '/tmp/received.bin',
      timeoutMs: 12_345,
    })).resolves.toEqual({
      destinationPath: '/tmp/blob-pack.bin',
      manifestHash: 'sha256:pack_123',
      sizeBytes: 12,
    });
    expect(requestDirectPeerTransferToFile).toHaveBeenCalledWith({
      transferId: 'blob_pack_transfer_123',
      endpointCandidates: [],
      destinationPath: '/tmp/received.bin',
      timeoutMs: 12_345,
    });

    await expect(transfers.requestServerRoutedBlobPackToFile({
      transferId: 'blob_pack_transfer_123',
      sourceMachineId: 'machine_source',
      machineTransferChannel: {
        onEnvelope: () => () => undefined,
        sendEnvelope: () => undefined,
      },
      destinationPath: '/tmp/received.bin',
    })).resolves.toEqual({
      destinationPath: '/tmp/blob-pack.bin',
      manifestHash: 'sha256:pack_123',
      sizeBytes: 12,
    });
    expect(requestServerRoutedTransferToFile).toHaveBeenCalledWith({
      transferId: 'blob_pack_transfer_123',
      sourceMachineId: 'machine_source',
      machineTransferChannel: {
        onEnvelope: expect.any(Function),
        sendEnvelope: expect.any(Function),
      },
      destinationPath: '/tmp/received.bin',
    });
  });

  it('rejects non-file direct-peer payload sources so blob packs stay file-backed', async () => {
    const publishTransfer = vi.fn();
    const { createWorkspaceReplicationTransfers } = await import('./workspaceReplicationTransfers');
    const transfers = createWorkspaceReplicationTransfers();

    expect(() =>
      transfers.publishDirectPeerBlobPack({
        transferId: 'blob_pack_transfer_inline',
        payloadSource: {
          kind: 'json',
          value: { blob: 'too large to inline' },
          manifestHash: 'sha256:inline',
        } as never,
        directPeerTransfer: {
          publishTransfer,
        },
      }),
    ).toThrow(/file-backed/i);
    expect(publishTransfer).not.toHaveBeenCalled();
  });
});
