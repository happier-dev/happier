import type { TransferEndpointCandidate, WorkspaceManifest } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { createBufferTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { buildWorkspaceReplicationBlobPacks } from '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks';
import {
  assertSafeWorkspaceReplicationPackId,
  createWorkspaceReplicationPackIdForDigests,
} from '@/workspaces/replication/transport/workspaceReplicationPackId';

import {
  buildSessionHandoffWorkspaceManifestTransferId,
  createSessionHandoffWorkspaceReplicationBlobPackPayloadSource,
} from './sessionHandoffWorkspaceReplicationServerRouted';
import { createSessionHandoffWorkspaceReplicationManifestPayloadSource } from './sessionHandoffWorkspaceReplicationManifestTransfer';

const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_DIRECT_PEER_PACK_MARKER = ':workspace-pack-direct:';

export function buildSessionHandoffWorkspaceDirectPeerBlobPackTransferId(input: Readonly<{
  handoffId: string;
  packId: string;
}>): string {
  // Direct peer transferIds are base64url-encoded and used as a Fastify path param.
  // Keep them short (do not embed digest lists) so we never exceed router param limits.
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_DIRECT_PEER_PACK_MARKER}${input.packId}`;
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

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index] ?? '';
    const next = values[index + 1];
    if (!current) return false;
    if (next !== undefined && current >= next) return false;
  }
  return true;
}

export async function publishSessionHandoffWorkspaceReplicationDirectPeerTransfers(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
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
  manifest: WorkspaceManifest;
  blobProvider?: WorkspaceExportBlobProvider;
}>): DirectPeerOnDemandTransferScope {
  const allowedDigests = new Set<string>();
  const allowedDigestSizesByDigest = new Map<string, number>();
  const allowedBlobs: { digest: string; sizeBytes: number }[] = [];
  for (const entry of input.manifest.entries) {
    if (entry.kind !== 'file') continue;
    if (allowedDigests.has(entry.digest)) {
      continue;
    }
    allowedDigests.add(entry.digest);
    allowedDigestSizesByDigest.set(entry.digest, entry.sizeBytes);
    allowedBlobs.push({
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
    });
  }
  const canonicalPacks = buildWorkspaceReplicationBlobPacks({
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
        return await createSessionHandoffWorkspaceReplicationManifestPayloadSource({
          manifest: input.manifest,
        });
      }

      const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
      if (!parsed || parsed.handoffId !== input.handoffId) {
        throw new Error('Invalid direct-peer blob-pack transfer request');
      }
      const safePackId = assertSafeWorkspaceReplicationPackId(parsed.packId);
      if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      const body = requestBody as Record<string, unknown>;
      if (body.t !== 'workspace_replication_blob_pack_v1') {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      if (body.packId !== safePackId) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      const digestsRaw = body.digests;
      if (!Array.isArray(digestsRaw) || digestsRaw.length === 0) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      if (digestsRaw.length > configuration.workspaceReplicationBlobPackMaxBlobs) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      if (digestsRaw.some((value) => typeof value !== 'string')) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      const digests = (digestsRaw as string[]).map((value) => value.trim());
      if (!isSortedUnique(digests)) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      const expectedPackId = createWorkspaceReplicationPackIdForDigests(digests);
      if (expectedPackId !== safePackId) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      for (const digest of digests) {
        if (!allowedDigests.has(digest)) {
          throw new Error('Invalid direct-peer blob-pack request body');
        }
      }

      // Enforce the same pack-shaping constraints the engine uses when requesting packs. Without
      // this, a peer could request a huge "pack" (maxBlobs * maxSingleBlobBytes) even though the
      // engine would never form such a pack under the target-bytes planner.
      let totalBytes = 0;
      for (const digest of digests) {
        const sizeBytes = allowedDigestSizesByDigest.get(digest);
        if (sizeBytes === undefined) {
          throw new Error('Invalid direct-peer blob-pack request body');
        }
        if (sizeBytes > configuration.workspaceReplicationBlobPackMaxSingleBlobBytes) {
          throw new Error('Invalid direct-peer blob-pack request body');
        }
        totalBytes += sizeBytes;
      }
      if (digests.length > 1 && totalBytes > configuration.workspaceReplicationBlobPackTargetBytes) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }

      return await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
        activeServerDir: input.activeServerDir,
        packId: safePackId,
        digests,
        blobProvider: input.blobProvider,
      });
    },
    // The manifest publication resolves once. Blob-pack requests are on-demand and may be
    // requested pack-by-pack by the target, so the budget must cover the pack count.
    maxResolvedTransfers: Math.max(1, 1 + canonicalPacks.length),
  };
}
