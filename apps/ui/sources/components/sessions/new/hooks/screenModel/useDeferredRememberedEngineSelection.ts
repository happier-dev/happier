import * as React from 'react';
import type {
    AcpConfigOptionOverridesV1,
    BackendTargetRefV2,
} from '@happier-dev/protocol';

import {
    areRememberedEngineSelectionsEquivalent,
    readRememberedEngineSelection,
    upsertRememberedEngineSelection,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';

export const REMEMBERED_ENGINE_SELECTION_WRITE_DELAY_MS = 3000;

type RememberedEngineSelectionInput = Readonly<{
    modelId: string;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
}>;

type DeferredRememberedEngineSelectionParams = Readonly<{
    enabled: boolean;
    selectionsByScope: RememberedEngineSelectionsByScopeV1 | null | undefined;
    serverId: string | null | undefined;
    commit: (nextSelectionsByScope: RememberedEngineSelectionsByScopeV1) => void;
    delayMs?: number;
}>;

type DeferredRememberedEngineSelectionRequest = Readonly<{
    backendTarget: BackendTargetRefV2;
    selection: RememberedEngineSelectionInput;
}>;

type DeferredRememberedEngineSelectionSnapshot =
    & DeferredRememberedEngineSelectionParams
    & DeferredRememberedEngineSelectionRequest;

function shouldCommitRememberedEngineSelection(params: DeferredRememberedEngineSelectionSnapshot): boolean {
    if (!params.enabled) return false;

    const nextSelectionsByScope = upsertRememberedEngineSelection({
        selectionsByScope: params.selectionsByScope,
        serverId: params.serverId,
        backendTarget: params.backendTarget,
        selection: params.selection,
        updatedAt: Date.now(),
    });
    const nextSelection = readRememberedEngineSelection({
        enabled: true,
        selectionsByScope: nextSelectionsByScope,
        serverId: params.serverId,
        backendTarget: params.backendTarget,
    });
    const currentSelection = readRememberedEngineSelection({
        enabled: true,
        selectionsByScope: params.selectionsByScope,
        serverId: params.serverId,
        backendTarget: params.backendTarget,
    });

    return !areRememberedEngineSelectionsEquivalent(currentSelection, nextSelection);
}

export function useDeferredRememberedEngineSelection(
    params: DeferredRememberedEngineSelectionParams,
): (backendTarget: BackendTargetRefV2, selection: RememberedEngineSelectionInput) => void {
    const latestParamsRef = React.useRef(params);
    latestParamsRef.current = params;
    const latestRequestRef = React.useRef<DeferredRememberedEngineSelectionRequest | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearPendingCommit = React.useCallback(() => {
        if (!timerRef.current) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const flushPendingCommit = React.useCallback(() => {
        clearPendingCommit();
        const latest = latestParamsRef.current;
        const request = latestRequestRef.current;
        if (!request) return;

        const snapshot = {
            ...latest,
            ...request,
        };
        if (!shouldCommitRememberedEngineSelection(snapshot)) return;

        latest.commit(upsertRememberedEngineSelection({
            selectionsByScope: latest.selectionsByScope,
            serverId: latest.serverId,
            backendTarget: request.backendTarget,
            selection: request.selection,
            updatedAt: Date.now(),
        }));
    }, [clearPendingCommit]);

    const rememberEngineSelection = React.useCallback((
        backendTarget: BackendTargetRefV2,
        selection: RememberedEngineSelectionInput,
    ) => {
        latestRequestRef.current = { backendTarget, selection };
        const latest = latestParamsRef.current;
        const snapshot = {
            ...latest,
            backendTarget,
            selection,
        };
        if (!shouldCommitRememberedEngineSelection(snapshot)) {
            clearPendingCommit();
            return;
        }

        clearPendingCommit();
        timerRef.current = setTimeout(
            flushPendingCommit,
            latest.delayMs ?? REMEMBERED_ENGINE_SELECTION_WRITE_DELAY_MS,
        );
    }, [clearPendingCommit, flushPendingCommit]);

    React.useEffect(() => {
        return () => {
            flushPendingCommit();
        };
    }, [flushPendingCommit]);

    return rememberEngineSelection;
}
