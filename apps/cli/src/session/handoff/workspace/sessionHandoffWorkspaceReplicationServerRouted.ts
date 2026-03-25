import {
  assertSafeWorkspaceReplicationPackId,
} from '@/workspaces/replication/transport/workspaceReplicationPackId';

export type { SessionHandoffWorkspaceBlobPackOpenBodyV1 } from './sessionHandoffWorkspaceReplicationBlobPackOpenBody';
export { parseSessionHandoffWorkspaceBlobPackOpenBody } from './sessionHandoffWorkspaceReplicationBlobPackOpenBody';
export { createSessionHandoffWorkspaceReplicationBlobPackPayloadSource } from './sessionHandoffWorkspaceReplicationBlobPackPayloadSource';
export {
  buildSessionHandoffWorkspaceManifestTransferId,
  parseSessionHandoffWorkspaceManifestTransferId,
} from './sessionHandoffWorkspaceReplicationManifestTransferId';

const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_PACK_MARKER = ':workspace-pack:';

type SessionHandoffWorkspaceBlobPackTransfer = Readonly<{
  handoffId: string;
  packId: string;
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
