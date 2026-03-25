import type { WorkspaceManifest } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import { countWorkspaceReplicationBlobPacks } from '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks';
import {
  assertSafeWorkspaceReplicationPackId,
} from '@/workspaces/replication/transport/workspaceReplicationPackId';

import { parseSessionHandoffWorkspaceBlobPackOpenBody } from './sessionHandoffWorkspaceReplicationBlobPackOpenBody';
import { createSessionHandoffWorkspaceReplicationBlobPackPayloadSource } from './sessionHandoffWorkspaceReplicationBlobPackPayloadSource';
import { buildSessionHandoffWorkspaceManifestTransferId } from './sessionHandoffWorkspaceReplicationManifestTransferId';
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

export function createSessionHandoffWorkspaceReplicationDirectPeerOnDemandScope(input: Readonly<{
  handoffId: string;
  activeServerDir: string;
  sourceRootPath: string;
  manifest: WorkspaceManifest;
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
        return await createSessionHandoffWorkspaceReplicationManifestPayloadSource({
          manifest: input.manifest,
        });
      }

      const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
      if (!parsed || parsed.handoffId !== input.handoffId) {
        throw new Error('Invalid direct-peer blob-pack transfer request');
      }
      const safePackId = assertSafeWorkspaceReplicationPackId(parsed.packId);
      const parsedBody = parseSessionHandoffWorkspaceBlobPackOpenBody(requestBody);
      if (!parsedBody || parsedBody.packId !== safePackId) {
        throw new Error('Invalid direct-peer blob-pack request body');
      }
      const digests = parsedBody.digests;
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
        sourceRootPath: input.sourceRootPath,
        manifest: input.manifest,
      });
    },
    // The manifest publication resolves once. Blob-pack requests are on-demand and may be
    // requested pack-by-pack by the target, so the budget must cover the pack count.
    maxResolvedTransfers: Math.max(1, 1 + canonicalPackCount),
  };
}
