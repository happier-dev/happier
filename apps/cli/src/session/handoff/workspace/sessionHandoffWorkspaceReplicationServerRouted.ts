import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { resolveInMemoryTransferMaxBytes } from '@/machines/transfer/inMemoryTransferSizeLimit';
import { configuration } from '@/configuration';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationBlobPackPayloadSource } from '@/workspaces/replication/transport/createWorkspaceReplicationBlobPackPayloadSource';
import { createWorkspaceReplicationPackIdForDigests } from '@/workspaces/replication/transport/workspaceReplicationPackId';

const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_PACK_MARKER = ':workspace-pack:';
const SESSION_HANDOFF_WORKSPACE_MANIFEST_MARKER = ':workspace-manifest';

type SessionHandoffWorkspaceBlobPackTransfer = Readonly<{
  handoffId: string;
  packId: string;
  digests: readonly string[];
}>;

type SessionHandoffWorkspaceManifestTransfer = Readonly<{
  handoffId: string;
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

function parseDecodedDigests(encodedDigests: string): readonly string[] | null {
  const maxBytes = resolveInMemoryTransferMaxBytes();

  // Reject oversized digest lists early: server-routed transfer ids are attacker-controlled input.
  // Use the in-memory transfer budget as the hard cap so this never becomes an OOM vector.
  const estimatedDecodedBytes = Math.ceil((encodedDigests.length * 3) / 4);
  if (!Number.isFinite(estimatedDecodedBytes) || estimatedDecodedBytes > maxBytes) {
    return null;
  }

  try {
    const decodedBuffer = Buffer.from(encodedDigests, 'base64url');
    if (decodedBuffer.byteLength > maxBytes) {
      return null;
    }
    const decoded = JSON.parse(decodedBuffer.toString('utf8'));
    if (!Array.isArray(decoded) || decoded.some((entry) => typeof entry !== 'string')) {
      return null;
    }
    const digests = decoded.map((entry) => entry.trim());
    if (digests.length === 0 || !isSortedUnique(digests)) {
      return null;
    }
    // Keep server-routed digest lists aligned with the canonical pack planning boundaries.
    // Without this, an attacker-controlled transferId can trigger huge CAS-seeding loops.
    if (digests.length > configuration.workspaceReplicationBlobPackMaxBlobs) {
      return null;
    }
    return digests;
  } catch {
    return null;
  }
}

export function buildSessionHandoffWorkspaceBlobPackTransferId(input: Readonly<{
  handoffId: string;
  packId: string;
  digests: readonly string[];
}>): string {
  const normalizedDigests = input.digests.map((digest) => String(digest ?? '').trim());
  if (normalizedDigests.length === 0 || normalizedDigests.length > configuration.workspaceReplicationBlobPackMaxBlobs) {
    throw new Error('Invalid workspace blob-pack digest list');
  }
  if (!isSortedUnique(normalizedDigests)) {
    throw new Error('Invalid workspace blob-pack digest list');
  }
  const expectedPackId = createWorkspaceReplicationPackIdForDigests(normalizedDigests);
  if (expectedPackId !== input.packId) {
    throw new Error('Invalid workspace blob-pack transfer id inputs');
  }
  const encodedDigests = Buffer.from(JSON.stringify([...normalizedDigests]), 'utf8').toString('base64url');
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_PACK_MARKER}${input.packId}:${encodedDigests}`;
}

export function parseSessionHandoffWorkspaceBlobPackTransferId(
  transferId: string,
): SessionHandoffWorkspaceBlobPackTransfer | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) {
    return null;
  }
  const markerIndex = transferId.indexOf(
    SESSION_HANDOFF_WORKSPACE_PACK_MARKER,
    SESSION_HANDOFF_TRANSFER_ID_PREFIX.length,
  );
  if (markerIndex < 0) {
    return null;
  }
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length, markerIndex).trim();
  const rest = transferId.slice(markerIndex + SESSION_HANDOFF_WORKSPACE_PACK_MARKER.length);
  const separatorIndex = rest.indexOf(':');
  if (handoffId.length === 0 || separatorIndex <= 0) {
    return null;
  }
  const packId = rest.slice(0, separatorIndex);
  const encodedDigests = rest.slice(separatorIndex + 1);
  const digests = parseDecodedDigests(encodedDigests);
  if (!digests || packId.length === 0) {
    return null;
  }
  const expectedPackId = createWorkspaceReplicationPackIdForDigests(digests);
  if (expectedPackId !== packId) {
    return null;
  }
  return {
    handoffId,
    packId,
    digests,
  };
}

export function buildSessionHandoffWorkspaceManifestTransferId(input: Readonly<{
  handoffId: string;
}>): string {
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_MANIFEST_MARKER}`;
}

export function parseSessionHandoffWorkspaceManifestTransferId(
  transferId: string,
): SessionHandoffWorkspaceManifestTransfer | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) {
    return null;
  }
  const markerIndex = transferId.indexOf(
    SESSION_HANDOFF_WORKSPACE_MANIFEST_MARKER,
    SESSION_HANDOFF_TRANSFER_ID_PREFIX.length,
  );
  if (markerIndex < 0) {
    return null;
  }
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length, markerIndex).trim();
  if (handoffId.length === 0) {
    return null;
  }
  return {
    handoffId,
  };
}

export async function createSessionHandoffWorkspaceReplicationBlobPackPayloadSource(input: Readonly<{
  activeServerDir: string;
  packId: string;
  digests: readonly string[];
  blobProvider?: WorkspaceExportBlobProvider;
}>): Promise<TransferPayloadSource> {
  try {
    return await createWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.activeServerDir,
      packId: input.packId,
      digests: input.digests,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Missing workspace replication CAS blob:')) {
      throw error;
    }

    if (!input.blobProvider) {
      // Inline blob maps are no longer supported; CAS seeding must come from the blob provider.
      throw new Error(`${error.message} (blobProvider unavailable; cannot seed workspace replication CAS)`);
    }

    const casStore = createWorkspaceReplicationCasStore({
      activeServerDir: input.activeServerDir,
    });
    for (const digest of input.digests) {
      if (await casStore.contains(digest)) {
        continue;
      }
      const blobPath = input.blobProvider.getBlobFilePath(digest);
      if (!blobPath) {
        throw new Error(`Missing workspace replication CAS blob and blobProvider path: ${digest}`);
      }
      await casStore.commitFile({
        digest,
        sourcePath: blobPath,
      });
    }

    return await createWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.activeServerDir,
      packId: input.packId,
      digests: input.digests,
    });
  }
}
