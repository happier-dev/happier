import type { TransferEndpointCandidate, WorkspaceManifest } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { createBufferTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { countWorkspaceReplicationBlobPacks } from '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks';
import {
  assertSafeWorkspaceReplicationPackId,
  createWorkspaceReplicationPackIdForDigests,
} from '@/workspaces/replication/transport/workspaceReplicationPackId';
import { parseWorkspaceReplicationBlobPackRequestV1 } from '@/workspaces/replication/transport/workspaceReplicationBlobPackRequestV1';
import { buildWorkspaceReplicationManifestDigestIndex } from '@/workspaces/replication/transport/workspaceReplicationManifestIndex';
import { assertWorkspaceReplicationBlobPackRequestWithinLimits } from '@/workspaces/replication/transport/assertWorkspaceReplicationBlobPackRequestWithinLimits';

import {
  buildSessionHandoffWorkspaceManifestTransferId,
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
} from './sessionHandoffWorkspaceReplicationServerRouted';
import { createWorkspaceReplicationManifestPayloadSource } from '@/workspaces/replication/transport/workspaceReplicationManifestTransferV1';

const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_DIRECT_PEER_PACK_MARKER = ':workspace-pack-direct:';

export function buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId(input: Readonly<{
  handoffId: string;
  packId: string;
}>): string {
  // Direct peer transferIds are base64url-encoded and used as a Fastify path param.
  // Keep them short (do not embed digest lists) so we never exceed router param limits.
  const safePackId = assertSafeWorkspaceReplicationPackId(input.packId);
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_DIRECT_PEER_PACK_MARKER}${safePackId}`;
}

export function parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId: string): Readonly<{
  handoffId: string;
  packId: string;
}> | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) {
    return null;
  }
  const markerIndex = transferId.indexOf(
    SESSION_HANDOFF_WORKSPACE_DIRECT_PEER_PACK_MARKER,
    SESSION_HANDOFF_TRANSFER_ID_PREFIX.length,
  );
  if (markerIndex < 0) {
    return null;
  }
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length, markerIndex).trim();
  const packId = transferId.slice(markerIndex + SESSION_HANDOFF_WORKSPACE_DIRECT_PEER_PACK_MARKER.length).trim();
  if (!handoffId || !packId) {
    return null;
  }
  return { handoffId, packId };
}

type DirectPeerTransferPublisher = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: Readonly<Record<never, never>>;
    payloadSource?: TransferPayloadSource;
    onDemandScope?: DirectPeerOnDemandTransferScope;
  }>) => readonly TransferEndpointCandidate[];
}>;

export type PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers = Readonly<{
  manifestTransferPublication?: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>;
  payloadSources: readonly Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>[];
}>;

export async function publishSessionHandoffWorkspaceReplicationDirectPeerTransfers(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
  sourceRootPath?: string;
  manifest: WorkspaceManifest;
  directPeerTransfer: DirectPeerTransferPublisher;
  blobProvider?: WorkspaceExportBlobProvider;
}>): Promise<PublishedSessionHandoffWorkspaceReplicationDirectPeerTransfers> {
  const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({
    handoffId: input.handoffId,
  });

  // Publish a tiny token carrier. The manifest and blob packs are served on-demand under the same
  // direct-peer token so the source never prepublishes a full manifest payload.
  const tokenCarrierPayloadSource = createBufferTransferPayloadSource(Buffer.from('{}', 'utf8'));

  const endpointCandidates = [
    ...input.directPeerTransfer.publishTransfer({
      transferId: manifestTransferId,
      payload: {},
      payloadSource: tokenCarrierPayloadSource,
      onDemandScope: createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope({
        handoffId: input.handoffId,
        activeServerDir: input.activeServerDir,
        sourceRootPath: input.sourceRootPath,
        manifest: input.manifest,
        blobProvider: input.blobProvider,
      }),
    }),
  ];

  return {
    manifestTransferPublication: {
      transferId: manifestTransferId,
      endpointCandidates,
    },
    payloadSources: [
      {
        transferId: manifestTransferId,
        payloadSource: tokenCarrierPayloadSource,
      },
    ],
  };
}

export function createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
  sourceRootPath?: string;
  manifest: WorkspaceManifest;
  blobProvider?: WorkspaceExportBlobProvider;
}>): DirectPeerOnDemandTransferScope {
  const digestIndex = buildWorkspaceReplicationManifestDigestIndex(input.manifest);
  const allowedBlobs = [...digestIndex.entries()].map(([digest, entry]) => ({
    digest,
    sizeBytes: entry.sizeBytes,
  }));
  const canonicalPackCount = countWorkspaceReplicationBlobPacks({
    blobs: allowedBlobs,
    blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
    blobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
    blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
  });
  const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({
    handoffId: input.handoffId,
  });

  return {
    allowTransferId: (transferId) => {
      if (transferId === manifestTransferId) return true;
      const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
      if (!parsed || parsed.handoffId !== input.handoffId) {
        return false;
      }
      try {
        assertSafeWorkspaceReplicationPackId(parsed.packId);
      } catch {
        return false;
      }
      return true;
    },
    resolvePayloadSourceOnOpen: async ({ transferId, requestBody }) => {
      if (transferId === manifestTransferId) {
        return await createWorkspaceReplicationManifestPayloadSource({
          manifest: input.manifest,
        });
      }

      const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
      if (!parsed || parsed.handoffId !== input.handoffId) {
        throw new Error('Invalid direct-peer blob-pack transfer request');
      }
      const safePackId = assertSafeWorkspaceReplicationPackId(parsed.packId);
      const openBody = parseWorkspaceReplicationBlobPackRequestV1(requestBody, {
        maxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
      });
      if (!openBody || openBody.packId !== safePackId) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      const digests = openBody.digests;
      if (createWorkspaceReplicationPackIdForDigests(digests) !== safePackId) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      try {
        assertWorkspaceReplicationBlobPackRequestWithinLimits({
          digestIndex,
          digests,
          blobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
          blobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
        });
      } catch {
        throw new Error('Invalid direct-peer blob-pack request body');
      }

      return await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: input.activeServerDir,
        packId: safePackId,
        digests,
        blobProvider: input.blobProvider,
        sourceRootPath: input.sourceRootPath,
        manifest: input.manifest,
      });
    },
    // The manifest publication resolves once. Blob-pack requests are on-demand and may be
    // requested pack-by-pack by the target, so the budget must cover the pack count.
    maxResolvedTransfers: Math.max(1, 1 + canonicalPackCount),
  };
}
