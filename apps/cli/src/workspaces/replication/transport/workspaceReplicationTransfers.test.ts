import { describe, expect, it, vi } from 'vitest';

import type { TransferEndpointCandidate } from '@happier-dev/protocol';

describe('workspaceReplicationTransfers', () => {
  it('publishes source offers through the provided direct-peer typed transfer handle', async () => {
    const { createWorkspaceReplicationTransfers } = await import('./workspaceReplicationTransfers');

    const endpointCandidates: readonly TransferEndpointCandidate[] = [
      {
        kind: 'http',
        url: 'http://127.0.0.1:46001/machine-transfers/direct/source-offer',
        authorizationToken: 'token',
        expiresAt: 1,
      },
    ];
    const publishTransfer = vi.fn(() => endpointCandidates);
    const transfers = createWorkspaceReplicationTransfers();

    expect(transfers.publishDirectPeerSourceOffer({
      transferId: 'offer_transfer_123',
      sourceOffer: {
        offerId: 'offer_123',
        relationshipId: 'relationship_123',
        directionId: 'direction_123',
        sourceFingerprint: 'sha256:manifest_123',
        manifest: {
          entries: [],
          fingerprint: 'sha256:manifest_123',
        },
        blobIndex: [],
      },
      directPeerTransfer: {
        publishTransfer,
      },
    })).toEqual(endpointCandidates);

    expect(publishTransfer).toHaveBeenCalledWith({
      transferId: 'offer_transfer_123',
      payload: {
        offerId: 'offer_123',
        relationshipId: 'relationship_123',
        directionId: 'direction_123',
        sourceFingerprint: 'sha256:manifest_123',
        manifest: {
          entries: [],
          fingerprint: 'sha256:manifest_123',
        },
        blobIndex: [],
      },
    });
  });

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
    const resolveLegacyWholeBufferMaxBytes = vi.fn(() => 999);

    const { createWorkspaceReplicationTransfers } = await import('./workspaceReplicationTransfers');
    const transfers = createWorkspaceReplicationTransfers({
      requestDirectPeerTransferToFile,
      requestServerRoutedTransferToFile,
      readWorkspaceReplicationSourceOfferFromFile,
      resolveLegacyWholeBufferMaxBytes,
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
      sizeBytes: 12,
      legacyWholeBufferMaxBytes: 999,
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
      sizeBytes: 34,
      legacyWholeBufferMaxBytes: 999,
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
    })).resolves.toEqual({
      destinationPath: '/tmp/blob-pack.bin',
      manifestHash: 'sha256:pack_123',
      sizeBytes: 12,
    });
    expect(requestDirectPeerTransferToFile).toHaveBeenCalledWith({
      transferId: 'blob_pack_transfer_123',
      endpointCandidates: [],
      destinationPath: '/tmp/received.bin',
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
});
