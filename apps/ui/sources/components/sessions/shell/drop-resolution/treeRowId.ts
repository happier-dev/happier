import type { SessionListIndexItem, SessionListOccurrenceRole } from '@/sync/domains/sessionList/sessionListIndex';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionListKeyParts, type NormalizedSessionListKeyParts } from '@/sync/domains/session/listing/sessionListKeyNormalization';

export const treeRowId = Object.freeze({
    folder: (serverId: string, folderId: string) => JSON.stringify([
        'folder',
        serverId.trim(),
        folderId.trim(),
    ]),
    session: (serverId: string, sessionId: string, keyParts?: NormalizedSessionListKeyParts, occurrenceRole: SessionListOccurrenceRole = 'base') => JSON.stringify([
        'session',
        normalizeSessionListKeyParts(serverId, sessionId, keyParts).sessionKey
            ?? sessionAddressKey({ serverId: serverId.trim(), sessionId: sessionId.trim() }),
        ...(occurrenceRole === 'base' ? [] : [occurrenceRole]),
    ]),
    workspaceRoot: (workspaceKey: string) => JSON.stringify(['workspace-root', workspaceKey.trim()]),
});

export function buildSessionListDragSourceId(scope: Readonly<{ serverId: string; accountId: string }>, sourceRowId: string): string {
    return `session-list-source:${scope.serverId}:${scope.accountId}:${sourceRowId}`;
}

function readTreeRowTuple(rowId: string): readonly unknown[] | null {
    try {
        const value: unknown = JSON.parse(rowId);
        return Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

export function isFolderTreeRowId(rowId: string): boolean {
    const tuple = readTreeRowTuple(rowId);
    return tuple?.length === 3
        && tuple[0] === 'folder'
        && typeof tuple[1] === 'string'
        && typeof tuple[2] === 'string';
}

export function isSessionTreeRowId(rowId: string): boolean {
    const tuple = readTreeRowTuple(rowId);
    return Boolean(tuple && (tuple.length === 2 || (tuple.length === 3 && (tuple[2] === 'needsYou' || tuple[2] === 'working')))
        && tuple[0] === 'session' && typeof tuple[1] === 'string');
}

export function isWorkspaceRootTreeRowId(rowId: string): boolean {
    const tuple = readTreeRowTuple(rowId);
    return tuple?.length === 2 && tuple[0] === 'workspace-root' && typeof tuple[1] === 'string';
}

export function resolveWorkspaceRootTreeRowId(item: Extract<SessionListIndexItem, { type: 'header' }>, fallbackTitle?: string): string {
    const baseKey = String(item.groupKey ?? item.workspaceKey ?? fallbackTitle ?? item.title ?? '').trim();
    return treeRowId.workspaceRoot(baseKey);
}

export function readFolderIdFromTreeRowId(rowId: string): string | null {
    const tuple = readTreeRowTuple(rowId);
    return isFolderTreeRowId(rowId) ? String(tuple?.[2] ?? '').trim() || null : null;
}
