import * as React from 'react';
import type {
    AcpConfigOptionOverridesV1,
    BackendTargetRefV2,
    SessionModelSelectionV1,
} from '@happier-dev/protocol';

import {
    areRememberedEngineSelectionsEquivalent,
    readRememberedEngineSelection,
    upsertRememberedEngineSelection,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';

export const REMEMBERED_ENGINE_SELECTION_WRITE_DELAY_MS = 3000;

type RememberedEngineSelectionInput = Readonly<{
    modelSelection: SessionModelSelectionV1 | null;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
}>;

type DeferredRememberedEngineSelectionParams = Readonly<{
    enabled: boolean;
    selectionsByScope: RememberedEngineSelectionsByScopeV1 | null | undefined;
    serverId: string | null | undefined;
    /** Exact Account scope and incumbent lifetime generation for this editor. */
    accountSettingsScope: AccountSettingsScope | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
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

function isAccountScopeLifetimeCurrent(
    params: Pick<DeferredRememberedEngineSelectionParams, 'accountLifetime' | 'accountSettingsScope'>,
): boolean {
    return params.accountLifetime !== null
        && params.accountSettingsScope !== null
        && areAccountSettingsScopesEqual(params.accountLifetime.scope, params.accountSettingsScope)
        && params.accountLifetime.isCurrent();
}

function isSnapshotCurrent(
    snapshot: DeferredRememberedEngineSelectionSnapshot,
    current: DeferredRememberedEngineSelectionParams,
): boolean {
    return snapshot.accountLifetime === current.accountLifetime
        && areAccountSettingsScopesEqual(snapshot.accountSettingsScope, current.accountSettingsScope)
        && isAccountScopeLifetimeCurrent(snapshot)
        && isAccountScopeLifetimeCurrent(current);
}

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
    const pendingSnapshotRef = React.useRef<DeferredRememberedEngineSelectionSnapshot | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearPendingCommit = React.useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        pendingSnapshotRef.current = null;
    }, []);

    const flushPendingCommit = React.useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        const snapshot = pendingSnapshotRef.current;
        pendingSnapshotRef.current = null;
        if (!snapshot) return;
        const latest = latestParamsRef.current;
        if (!isSnapshotCurrent(snapshot, latest)) return;
        if (!shouldCommitRememberedEngineSelection(snapshot)) return;

        snapshot.commit(upsertRememberedEngineSelection({
            selectionsByScope: snapshot.selectionsByScope,
            serverId: snapshot.serverId,
            backendTarget: snapshot.backendTarget,
            selection: snapshot.selection,
            updatedAt: Date.now(),
        }));
    }, []);

    const rememberEngineSelection = React.useCallback((
        backendTarget: BackendTargetRefV2,
        selection: RememberedEngineSelectionInput,
    ) => {
        const latest = latestParamsRef.current;
        const snapshot = {
            ...latest,
            backendTarget,
            selection,
        };
        if (!isAccountScopeLifetimeCurrent(snapshot)
            || !shouldCommitRememberedEngineSelection(snapshot)) {
            clearPendingCommit();
            return;
        }

        clearPendingCommit();
        pendingSnapshotRef.current = snapshot;
        timerRef.current = setTimeout(
            flushPendingCommit,
            latest.delayMs ?? REMEMBERED_ENGINE_SELECTION_WRITE_DELAY_MS,
        );
    }, [clearPendingCommit, flushPendingCommit]);

    React.useEffect(() => {
        const pending = pendingSnapshotRef.current;
        if (pending && !isSnapshotCurrent(pending, params)) {
            clearPendingCommit();
        }
        const retirement = params.accountLifetime?.onRetire(clearPendingCommit);
        return () => retirement?.dispose();
    }, [clearPendingCommit, params.accountLifetime, params.accountSettingsScope]);

    React.useEffect(() => {
        return () => {
            flushPendingCommit();
        };
    }, [flushPendingCommit]);

    return rememberEngineSelection;
}
