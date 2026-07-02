import React from 'react';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

type SessionRowMoveActionItem = Extract<SessionListIndexItem, { type: 'session' }>;
type MoveKeyboardDirection = 'up' | 'down';

type SessionRowMoveActionDependencies = Readonly<{
    openMoveSheetForTreeRow: (sourceRowId: string, sourceLabel: string) => Promise<void>;
    moveTreeRowToWorkspaceRoot: (sourceRowId: string, sourceLabel: string) => void;
    moveTreeRowByKeyboard: (sourceRowId: string, sourceLabel: string, direction: MoveKeyboardDirection) => void;
    handleMoveSessionToFolder: (sessionId: string, serverId: string, folderId: string | null) => void | Promise<void>;
}>;

type SessionRowMoveActionEntry = {
    sourceRowId: string;
    sourceLabel: string;
    item: SessionRowMoveActionItem;
    onMoveToFolder: () => void;
    onMoveToWorkspaceRoot: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onMoveToSessionFolder: (folderId: string | null) => void;
};

type SessionRowMoveActionRequest = Readonly<{
    sourceRowId: string;
    sourceLabel: string;
    item: SessionRowMoveActionItem;
}>;

export type SessionRowMoveActionHandlers = Readonly<{
    onMoveToFolder: () => void;
    onMoveToWorkspaceRoot: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onMoveToSessionFolder: (folderId: string | null) => void;
}>;

export function useSessionListRowMoveActionHandlers(
    dependencies: SessionRowMoveActionDependencies,
): (request: SessionRowMoveActionRequest) => SessionRowMoveActionHandlers {
    const dependenciesRef = React.useRef(dependencies);
    dependenciesRef.current = dependencies;
    const handlersByRowIdRef = React.useRef(new Map<string, SessionRowMoveActionEntry>());

    return React.useCallback((request: SessionRowMoveActionRequest): SessionRowMoveActionHandlers => {
        const rowId = request.sourceRowId;
        const cache = handlersByRowIdRef.current;
        let entry = cache.get(rowId);
        if (!entry) {
            entry = {
                sourceRowId: rowId,
                sourceLabel: request.sourceLabel,
                item: request.item,
                onMoveToFolder: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    void dependenciesRef.current.openMoveSheetForTreeRow(current.sourceRowId, current.sourceLabel);
                },
                onMoveToWorkspaceRoot: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    dependenciesRef.current.moveTreeRowToWorkspaceRoot(current.sourceRowId, current.sourceLabel);
                },
                onMoveUp: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    dependenciesRef.current.moveTreeRowByKeyboard(current.sourceRowId, current.sourceLabel, 'up');
                },
                onMoveDown: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    dependenciesRef.current.moveTreeRowByKeyboard(current.sourceRowId, current.sourceLabel, 'down');
                },
                onMoveToSessionFolder: (folderId: string | null) => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    const serverId = typeof current?.item.serverId === 'string' ? current.item.serverId.trim() : '';
                    const sessionId = typeof current?.item.sessionId === 'string' ? current.item.sessionId.trim() : '';
                    if (!current || !serverId || !sessionId) return;
                    void dependenciesRef.current.handleMoveSessionToFolder(sessionId, serverId, folderId);
                },
            };
            cache.set(rowId, entry);
        } else {
            entry.sourceLabel = request.sourceLabel;
            entry.item = request.item;
        }

        return {
            onMoveToFolder: entry.onMoveToFolder,
            onMoveToWorkspaceRoot: entry.onMoveToWorkspaceRoot,
            onMoveUp: entry.onMoveUp,
            onMoveDown: entry.onMoveDown,
            onMoveToSessionFolder: entry.onMoveToSessionFolder,
        };
    }, []);
}
