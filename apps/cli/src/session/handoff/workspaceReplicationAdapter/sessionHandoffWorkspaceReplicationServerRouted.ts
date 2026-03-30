import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationBlobPackPayloadSource } from '@/workspaces/replication/transport/createWorkspaceReplicationBlobPackPayloadSource';
import { seedWorkspaceReplicationCasBlobsFromManifest } from '@/workspaces/replication/transport/seedWorkspaceReplicationCasBlobsFromManifest';
import {
  assertSafeWorkspaceReplicationPackId,
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
  sourceRootPath?: string;
  manifest?: WorkspaceManifest;
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

    if (input.blobProvider) {
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
    } else if (input.sourceRootPath && input.manifest) {
      await seedWorkspaceReplicationCasBlobsFromManifest({
        activeServerDir: input.activeServerDir,
        sourceRootPath: input.sourceRootPath,
        manifest: input.manifest,
        digests: input.digests,
      });
    } else {
      throw new Error(
        `${error.message} (blobProvider or sourceRootPath+manifest required; cannot seed workspace replication CAS)`,
      );
    }

    return await createWorkspaceReplicationBlobPackPayloadSource({
      activeServerDir: input.activeServerDir,
      packId: input.packId,
      digests: input.digests,
    });
  }
}
