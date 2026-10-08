import React from 'react';

type MoveKeyboardDirection = 'up' | 'down';

type SessionRowMoveActionDependencies = Readonly<{
    openMoveSheetForTreeRow: (sourceRowId: string, sourceLabel: string) => Promise<void>;
    moveTreeRowToWorkspaceRoot: (sourceRowId: string, sourceLabel: string) => void;
    moveTreeRowByKeyboard: (sourceRowId: string, sourceLabel: string, direction: MoveKeyboardDirection) => void;
}>;

type SessionRowMoveActionEntry = {
    sourceRowId: string;
    sourceLabel: string;
    onMoveToFolder: () => void;
    onMoveToWorkspaceRoot: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
};

type SessionRowMoveActionRequest = Readonly<{
    sourceRowId: string;
    sourceLabel: string;
}>;

export type SessionRowMoveActionHandlers = Readonly<{
    onMoveToFolder: () => void;
    onMoveToWorkspaceRoot: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
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
            };
            cache.set(rowId, entry);
        } else {
            entry.sourceLabel = request.sourceLabel;
        }

        return {
            onMoveToFolder: entry.onMoveToFolder,
            onMoveToWorkspaceRoot: entry.onMoveToWorkspaceRoot,
            onMoveUp: entry.onMoveUp,
            onMoveDown: entry.onMoveDown,
        };
    }, []);
}
