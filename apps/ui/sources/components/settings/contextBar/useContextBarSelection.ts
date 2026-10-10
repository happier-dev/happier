import * as React from 'react';

import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { requireUpdatedPromptLibraryMutation } from '@/sync/api/account/apiPromptLibraryCatalog';

type UseContextBarSelectionArgs = Readonly<{
    selectionKey: string;
    defaultMachineId: string | null;
    initialMachineId?: string | null;
    defaultWorkspacePath?: string | null;
    /** Administration's existing qualified target; it owns placement, not this Context row. */
    workspaceBindingKey?: string;
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
    const catalog = usePromptLibraryCatalogValue('contexts');
    const contextSelectionsV1 = catalog.status === 'ready' && !catalog.stale ? catalog.value : null;
    const scope = useAccountSettingsScope();
    const boundary = JSON.stringify([scope?.serverId, scope?.accountId, args.selectionKey]);
    const storedSelection = readStoredSelection(contextSelectionsV1?.selectionsByKey, args.selectionKey);
    const storedMachineId = storedSelection?.machineId ?? null;
    const storedWorkspacePath = storedSelection?.workspacePath ?? null;
    const defaultWorkspacePath = args.defaultWorkspacePath ?? '';
    const initialMachineIdRef = React.useRef(args.initialMachineId ?? null);

    const [draft, setDraft] = React.useState<Readonly<{ boundary: string; machineId: string | null; workspacePath: string }> | null>(null);
    const [workspaceBinding, setWorkspaceBinding] = React.useState(() => ({ boundary, key: args.workspaceBindingKey }));
    const workspaceBindingChanged = workspaceBinding.boundary === boundary
        && Boolean(workspaceBinding.key)
        && args.workspaceBindingKey !== undefined
        && workspaceBinding.key !== args.workspaceBindingKey;
    const currentDraft = draft?.boundary === boundary ? draft : null;
    const machineId = currentDraft ? currentDraft.machineId : initialMachineIdRef.current ?? storedMachineId ?? args.defaultMachineId ?? null;
    const workspacePath = workspaceBindingChanged ? '' : currentDraft ? currentDraft.workspacePath : storedWorkspacePath ?? defaultWorkspacePath;
    React.useEffect(() => { initialMachineIdRef.current = null; }, [boundary]);

    const persistSelection = React.useCallback(async (nextSelection: StoredContextSelection) => {
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
        if (!contextSelectionsV1) return;
        try {
            requireUpdatedPromptLibraryMutation(await catalog.write({
                v: 1,
                selectionsByKey: {
                    ...contextSelectionsV1.selectionsByKey,
                    [args.selectionKey]: normalizedSelection,
                },
            }));
            setDraft(current => current?.boundary === boundary
                && current.machineId === normalizedSelection.machineId
                && current.workspacePath === normalizedSelection.workspacePath ? null : current);
        } catch {
            // Keep the local choice for retry; an unacknowledged draft is not catalog authority.
        }
    }, [args.selectionKey, boundary, catalog.write, contextSelectionsV1]);

    React.useLayoutEffect(() => {
        if (workspaceBinding.boundary === boundary && workspaceBinding.key === args.workspaceBindingKey) return;
        setWorkspaceBinding({ boundary, key: args.workspaceBindingKey });
        if (!workspaceBindingChanged) return;
        setDraft({ boundary, machineId, workspacePath: '' });
        void persistSelection({ machineId, workspacePath: '' });
    }, [args.workspaceBindingKey, boundary, machineId, persistSelection, workspaceBinding, workspaceBindingChanged]);

    const setMachineId = React.useCallback(async (nextMachineId: string | null) => {
        if ((machineId ?? null) === (nextMachineId ?? null)) {
            return;
        }
        setDraft({ boundary, machineId: nextMachineId, workspacePath });
        await persistSelection({
            machineId: nextMachineId,
            workspacePath,
        });
    }, [boundary, machineId, persistSelection, workspacePath]);

    const setWorkspacePath = React.useCallback(async (nextWorkspacePath: string) => {
        if (workspacePath === nextWorkspacePath) {
            return;
        }
        setDraft({ boundary, machineId, workspacePath: nextWorkspacePath });
        await persistSelection({
            machineId,
            workspacePath: nextWorkspacePath,
        });
    }, [boundary, machineId, persistSelection, workspacePath]);

    return {
        machineId,
        setMachineId,
        workspacePath,
        setWorkspacePath,
    };
}
