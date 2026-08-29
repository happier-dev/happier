/**
 * The pre-0.3 workspaceTransfer payload is intentionally not interpreted by the
 * handoff API anymore.  Keep the boundary diagnostic in one place so every
 * handoff entry point fails closed before it can touch the retired replication
 * engine or stop a source session.
 */
export type WorkspaceSyncUpdateRequired = Readonly<{
  ok: false;
  errorCode: 'workspace_sync_update_required';
  error: string;
}>;

export function workspaceSyncUpdateRequired(): WorkspaceSyncUpdateRequired {
  return {
    ok: false,
    errorCode: 'workspace_sync_update_required',
    error: 'Workspace handoff requires a workspace sync capable client',
  };
}

/**
 * Detect a retired request field without relying on a schema parser.  The
 * current protocol schema rejects this field, but inspecting raw input first
 * lets callers return the typed update-required result instead of a generic
 * invalid-request response (and, importantly, before any side effects).
 */
export function hasRetiredWorkspaceTransfer(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!Object.prototype.hasOwnProperty.call(raw, 'workspaceTransfer')) return false;
  const value = (raw as Readonly<Record<string, unknown>>).workspaceTransfer;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Readonly<Record<string, unknown>>).enabled === true);
}

/**
 * Detect a workspace action that this handoff owner cannot execute.  The
 * canonical workspace-sync adapter owns workspace preparation; until it is
 * available, handoff must reject the action before reading state or stopping
 * the source session.  Legacy reverse-root fields are included because they
 * can still arrive through the released commit compatibility envelope.
 */
export function hasUnsupportedWorkspaceAction(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Readonly<Record<string, unknown>>;
  if (hasRetiredWorkspaceTransfer(raw)) return true;
  if (Object.prototype.hasOwnProperty.call(value, 'workspaceTransfer')) return true;

  const action = value.workspaceAction;
  if (action !== undefined) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return true;
    if ((action as Readonly<Record<string, unknown>>).kind !== 'none') return true;
  }

  return Object.prototype.hasOwnProperty.call(value, 'workspaceReplicationReverseSourceRootPath')
    || Object.prototype.hasOwnProperty.call(value, 'workspaceReplicationReverseTargetRootPath');
}
