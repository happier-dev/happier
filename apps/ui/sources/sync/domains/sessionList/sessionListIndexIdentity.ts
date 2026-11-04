import { normalizeSessionListKeyParts, type NormalizedSessionListKeyParts } from '../session/listing/sessionListKeyNormalization';

export type SessionListOccurrenceRole = 'base' | 'needsYou' | 'working';

/** Identity callers need only these facts, not the UI index's rendering or policy graph. */
export type SessionListIndexIdentityInput =
    | Readonly<{
        type: 'header';
        headerKind?: string;
        groupKey?: string;
        presentationAnchorGroupKey?: string;
        serverId?: string;
        workspaceKey?: string;
        folderId?: string;
        machine?: Readonly<{ id: string }>;
        workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
    }>
    | Readonly<{
        type: 'session';
        serverId?: string;
        sessionId: string;
        keyParts?: NormalizedSessionListKeyParts;
        occurrenceRole?: SessionListOccurrenceRole;
    }>
    | Readonly<{ type: 'workflow_run'; serverId?: string; runId: string }>;

function buildSessionListIndexHeaderNodeId(item: Extract<SessionListIndexIdentityInput, { type: 'header' }>): string {
    const headerKind = String(item.headerKind ?? '').trim() || 'header';
    const groupKey = String(item.groupKey ?? '').trim();
    const serverId = String(item.serverId ?? '').trim();
    const workspaceKey = String(item.workspaceKey ?? '').trim();
    const folderId = String(item.folderId ?? '').trim();
    const machineId = String(item.machine?.id ?? '').trim();
    const workspaceScopeHint = item.workspaceScopeHint ?? null;
    const hintServerId = String(workspaceScopeHint?.serverId ?? '').trim();
    const hintMachineId = String(workspaceScopeHint?.machineId ?? '').trim();
    const hintRootPath = String(workspaceScopeHint?.rootPath ?? '').trim();
    const anchorGroupKey = String(item.presentationAnchorGroupKey ?? '').trim();

    // Caller-controlled labels and addresses can contain any delimiter.
    if (groupKey) return `header:${JSON.stringify(anchorGroupKey
        ? [headerKind, groupKey, folderId, anchorGroupKey] : [headerKind, groupKey, folderId])}`;
    return `header:${JSON.stringify([
        headerKind, serverId, workspaceKey, folderId, machineId,
        hintServerId, hintMachineId, hintRootPath,
        ...(anchorGroupKey ? [anchorGroupKey] : []),
    ])}`;
}

/** Entity identity belongs to subscriptions and operations, independent of presentation. */
export function buildSessionListIndexEntityId<Item extends SessionListIndexIdentityInput>(item: Item): string {
    if (item.type === 'header') return buildSessionListIndexHeaderNodeId(item);
    const serverId = String(item.serverId ?? '').trim();
    if (item.type === 'workflow_run') return `workflow_run:${JSON.stringify([serverId, item.runId])}`;
    const sessionId = String(item.sessionId ?? '').trim();
    if (serverId && sessionId) return `session:${normalizeSessionListKeyParts(serverId, sessionId, item.keyParts).sessionKey}`;
    return `session:${sessionId}`;
}

/** A needs-you / working shortcut copy of a Session row, listed beside its ordinary (base) row. */
export function isSessionListShortcutOccurrence(item: SessionListIndexIdentityInput): boolean {
    return item.type === 'session' && !!item.occurrenceRole && item.occurrenceRole !== 'base';
}

/** The base identity survives grouping changes; shelf copies have separate view identities. */
export function buildSessionListIndexNodeId<Item extends SessionListIndexIdentityInput>(item: Item): string {
    const entityId = buildSessionListIndexEntityId(item);
    return item.type === 'session' && isSessionListShortcutOccurrence(item)
        ? `occurrence:${JSON.stringify([entityId, item.occurrenceRole])}`
        : entityId;
}
