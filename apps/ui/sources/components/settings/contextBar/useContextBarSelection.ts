import * as React from 'react';

import { useSettingMutable } from '@/sync/domains/state/storage';

type UseContextBarSelectionArgs = Readonly<{
    selectionKey: string;
    defaultMachineId: string | null;
    defaultWorkspacePath?: string | null;
}>;

type StoredContextSelection = Readonly<{
    machineId?: string | null;
    workspacePath?: string | null;
}>;

function readStoredSelection(
    selectionsByKey: Record<string, StoredContextSelection> | null | undefined,
    selectionKey: string,
): StoredContextSelection | null {
    if (!selectionKey) return null;
    const stored = selectionsByKey?.[selectionKey];
    return stored && typeof stored === 'object' ? stored : null;
}

export function useContextBarSelection(args: UseContextBarSelectionArgs) {
    const [contextSelectionsV1, setContextSelectionsV1] = useSettingMutable('contextSelectionsV1');
    const storedSelection = readStoredSelection(contextSelectionsV1?.selectionsByKey, args.selectionKey);
    const storedMachineId = storedSelection?.machineId ?? null;
    const storedWorkspacePath = storedSelection?.workspacePath ?? null;
    const defaultWorkspacePath = args.defaultWorkspacePath ?? '';

    const [machineId, setMachineIdState] = React.useState<string | null>(
        () => storedMachineId ?? args.defaultMachineId ?? null,
    );
    const [workspacePath, setWorkspacePathState] = React.useState<string>(
        () => storedWorkspacePath ?? defaultWorkspacePath,
    );

    React.useEffect(() => {
        setMachineIdState(storedMachineId ?? args.defaultMachineId ?? null);
    }, [args.defaultMachineId, storedMachineId]);

    React.useEffect(() => {
        setWorkspacePathState(storedWorkspacePath ?? defaultWorkspacePath);
    }, [defaultWorkspacePath, storedWorkspacePath]);

    const persistSelection = React.useCallback((nextSelection: StoredContextSelection) => {
        const normalizedSelection = {
            machineId: nextSelection.machineId ?? null,
            workspacePath: nextSelection.workspacePath ?? null,
        };
        const currentSelection = readStoredSelection(contextSelectionsV1?.selectionsByKey, args.selectionKey);
        if (
            (currentSelection?.machineId ?? null) === normalizedSelection.machineId
            && (currentSelection?.workspacePath ?? null) === normalizedSelection.workspacePath
        ) {
            return;
        }
        setContextSelectionsV1({
            v: 1,
            selectionsByKey: {
                ...(contextSelectionsV1?.selectionsByKey ?? {}),
                [args.selectionKey]: normalizedSelection,
            },
        });
    }, [args.selectionKey, contextSelectionsV1?.selectionsByKey, setContextSelectionsV1]);

    const setMachineId = React.useCallback((nextMachineId: string | null) => {
        if ((machineId ?? null) === (nextMachineId ?? null)) {
            return;
        }
        setMachineIdState(nextMachineId);
        persistSelection({
            machineId: nextMachineId,
            workspacePath,
        });
    }, [machineId, persistSelection, workspacePath]);

    const setWorkspacePath = React.useCallback((nextWorkspacePath: string) => {
        if (workspacePath === nextWorkspacePath) {
            return;
        }
        setWorkspacePathState(nextWorkspacePath);
        persistSelection({
            machineId,
            workspacePath: nextWorkspacePath,
        });
    }, [machineId, persistSelection, workspacePath]);

    return {
        machineId,
        setMachineId,
        workspacePath,
        setWorkspacePath,
    };
}
