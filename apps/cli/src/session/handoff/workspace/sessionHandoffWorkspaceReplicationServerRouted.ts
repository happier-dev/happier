import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { configuration } from '@/configuration';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationBlobPackPayloadSource } from '@/workspaces/replication/transport/createWorkspaceReplicationBlobPackPayloadSource';
import {
  assertSafeWorkspaceReplicationPackId,
  createWorkspaceReplicationPackIdForDigests,
} from '@/workspaces/replication/transport/workspaceReplicationPackId';

const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_PACK_MARKER = ':workspace-pack:';
const SESSION_HANDOFF_WORKSPACE_MANIFEST_MARKER = ':workspace-manifest';

type SessionHandoffWorkspaceBlobPackTransfer = Readonly<{
  handoffId: string;
  packId: string;
}>;

type SessionHandoffWorkspaceManifestTransfer = Readonly<{
  handoffId: string;
}>;

export type SessionHandoffWorkspaceBlobPackOpenBodyV1 = Readonly<{
  t: 'workspace_replication_blob_pack_v1';
  packId: string;
  digests: readonly string[];
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

export function buildSessionHandoffWorkspaceBlobPackTransferId(input: Readonly<{
  handoffId: string;
  packId: string;
}>): string {
  const packId = assertSafeWorkspaceReplicationPackId(input.packId);
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_PACK_MARKER}${packId}`;
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
  if (handoffId.length === 0 || rest.length === 0) {
    return null;
  }
  let packId: string;
  try {
    packId = assertSafeWorkspaceReplicationPackId(rest);
  } catch {
    return null;
  }
  return {
    handoffId,
    packId,
  };
}

export function parseSessionHandoffWorkspaceBlobPackOpenBody(
  input: unknown,
): SessionHandoffWorkspaceBlobPackOpenBodyV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (record.t !== 'workspace_replication_blob_pack_v1') {
    return null;
  }
  if (typeof record.packId !== 'string' || record.packId.trim().length === 0) {
    return null;
  }
  if (!Array.isArray(record.digests) || record.digests.some((digest) => typeof digest !== 'string')) {
    return null;
  }

  let packId: string;
  try {
    packId = assertSafeWorkspaceReplicationPackId(record.packId);
  } catch {
    return null;
  }

  const digests = record.digests.map((digest) => digest.trim());
  // Fail closed: do not drop blank entries (prevents request-body smuggling and keeps packId stable).
  if (digests.length === 0 || digests.some((digest) => digest.length === 0) || !isSortedUnique(digests)) {
    return null;
  }
  if (digests.length > configuration.workspaceReplicationBlobPackMaxBlobs) {
    return null;
  }
  const expectedPackId = createWorkspaceReplicationPackIdForDigests(digests);
  if (expectedPackId !== packId) {
    return null;
  }

  return {
    t: 'workspace_replication_blob_pack_v1',
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
