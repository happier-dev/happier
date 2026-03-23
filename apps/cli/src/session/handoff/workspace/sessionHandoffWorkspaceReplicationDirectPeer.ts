import type { TransferEndpointCandidate, WorkspaceManifest } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createWorkspaceReplicationPackIdForDigests } from '@/workspaces/replication/transport/workspaceReplicationPackId';

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

function parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId: string): Readonly<{
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
  const payloadSources: Array<Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>> = [];
  const allowedDigests = new Set<string>();
  for (const entry of input.manifest.entries) {
    if (entry.kind !== 'file') continue;
    allowedDigests.add(entry.digest);
  }

  const manifestTransferId = buildSessionHandoffWorkspaceManifestTransferId({
    handoffId: input.handoffId,
  });
  const manifestPayloadSource = await createSessionHandoffWorkspaceReplicationManifestPayloadSource({
    manifest: input.manifest,
  });
  const manifestEndpointCandidates = input.directPeerTransfer.publishTransfer({
    transferId: manifestTransferId,
    payload: {},
    payloadSource: manifestPayloadSource,
    onDemandScope: {
      allowTransferId: (transferId) => {
        const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
        return parsed?.handoffId === input.handoffId;
      },
      resolvePayloadSourceOnOpen: async ({ transferId, requestBody }) => {
        const parsed = parseSessionHandoffWorkspaceDirectPeerBlobPackTransferId(transferId);
        if (!parsed || parsed.handoffId !== input.handoffId) {
          throw new Error('Invalid direct-peer blob-pack transfer request');
        }
        if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
          throw new Error('Invalid direct-peer blob-pack request body');
        }
        const body = requestBody as Record<string, unknown>;
        if (body.t !== 'workspace_replication_blob_pack_v1') {
          throw new Error('Invalid direct-peer blob-pack request body');
        }
        if (body.packId !== parsed.packId) {
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
        if (expectedPackId !== parsed.packId) {
          throw new Error('Invalid direct-peer blob-pack request body');
        }
        for (const digest of digests) {
          if (!allowedDigests.has(digest)) {
            throw new Error('Invalid direct-peer blob-pack request body');
          }
        }
        return await createSessionHandoffWorkspaceReplicationBlobPackPayloadSource({
          activeServerDir: input.activeServerDir,
          packId: parsed.packId,
          digests,
          blobProvider: input.blobProvider,
        });
      },
      // Worst-case: the target requests one digest per pack (e.g. tiny target bytes budget).
      // Bound to the manifest's digest count: callers should only request the canonical pack ids
      // derived from the manifest, and in the worst case that is one pack per digest.
      maxResolvedTransfers: Math.max(1, allowedDigests.size),
    },
  });
  payloadSources.push({
    transferId: manifestTransferId,
    payloadSource: manifestPayloadSource,
  });

  return {
    manifestTransferPublication: {
      transferId: manifestTransferId,
      endpointCandidates: manifestEndpointCandidates,
    },
    payloadSources,
  };
}
