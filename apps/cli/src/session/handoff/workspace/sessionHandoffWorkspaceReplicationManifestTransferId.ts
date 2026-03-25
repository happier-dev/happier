const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_MANIFEST_MARKER = ':workspace-manifest';

type SessionHandoffWorkspaceManifestTransfer = Readonly<{
  handoffId: string;
}>;

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
