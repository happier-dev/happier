import * as React from 'react';

import type { OpenApprovalAttentionArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useActiveServerAccountScope, useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import {
    dismissFailedApproval,
    EMPTY_FAILED_APPROVAL_DISMISSALS,
    failedApprovalDismissalsState,
    failedApprovalDismissalScopeKey,
    migrateFailedApprovalDismissals,
} from '@/sync/domains/state/failedApprovalUiState';
import { UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { LocalSettingsPersistenceError } from '@/sync/domains/state/settingsPersistence';
import type { ResolvedPermissionPromptSurface } from '@/utils/sessions/permissions/permissionPromptPolicy';

/**
 * A failed approval stays in the composer until this device dismisses it. Dismissal is presentation only:
 * the approval is unchanged and nothing is sent anywhere, so it needs no confirmation.
 */
export function useFailedApprovalDismissal() {
    const scope = useActiveServerAccountScope();
    const scopeKey = scope ? failedApprovalDismissalScopeKey(scope) : null;
    const dismissed = usePersistentUiStateValue(failedApprovalDismissalsState, scopeKey) ?? EMPTY_FAILED_APPROVAL_DISMISSALS;
    const dismiss = React.useCallback((artifactId: string) => {
        if (!scopeKey) return;
        const currentScope = getStorage().getState().profileScope;
        if (!currentScope || failedApprovalDismissalScopeKey(currentScope) !== scopeKey) return;
        try {
            dismissFailedApproval(scopeKey, artifactId);
        } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[approvals] Dismissal could not be persisted; keeping the current record.');
        }
    }, [scopeKey]);
    return { dismissed, dismiss };
}

/** The composer's attention requests: every open approval, and each settled failure not yet dismissed here. */
export function useComposerApprovalRequests<T extends OpenApprovalAttentionArtifactForSession>(
    requests: readonly T[],
): readonly T[] {
    const { dismissed } = useFailedApprovalDismissal();
    const scope = useActiveServerAccountScope();
    const legacy = useLocalSetting('dismissedFailedApprovalsV1');
    const scopeKey = scope ? failedApprovalDismissalScopeKey(scope) : null;
    React.useEffect(() => {
        if (!scopeKey) return;
        const state = getStorage().getState();
        if (!state.profileScope || failedApprovalDismissalScopeKey(state.profileScope) !== scopeKey) return;
        // Historical ids have no Home/Account provenance. Only a real approval
        // observed in this scope can qualify its old presentation timestamp.
        const migrated = Object.fromEntries(requests.filter(({ artifact }) => Object.hasOwn(legacy, artifact.id))
            .map(({ artifact }) => [artifact.id, legacy[artifact.id]]));
        if (Object.keys(migrated).length === 0) return;
        try {
            migrateFailedApprovalDismissals(scopeKey, migrated);
            const remaining = { ...state.localSettings.dismissedFailedApprovalsV1 };
            for (const id of Object.keys(migrated)) delete remaining[id];
            state.applyLocalSettings({ dismissedFailedApprovalsV1: remaining }, { source: 'ui' });
        } catch (error) {
            if (!(error instanceof UiStatePersistenceError) && !(error instanceof LocalSettingsPersistenceError)) throw error;
            console.warn('[approvals] Retained dismissal migration could not be persisted; keeping the original timestamps.');
        }
    }, [legacy, requests, scopeKey]);
    return React.useMemo(
        () => requests.filter(({ artifact, approval }) => approval.status === 'open'
            || (dismissed[artifact.id] === undefined && (!scopeKey || legacy[artifact.id] === undefined))),
        [dismissed, legacy, requests, scopeKey],
    );
}

/** Surface preference moves only open approvals; settled failures remain composer attention. */
export function selectComposerApprovalRequestsForSurface(
    requests: readonly OpenApprovalAttentionArtifactForSession[],
    surface: ResolvedPermissionPromptSurface,
): readonly OpenApprovalAttentionArtifactForSession[] {
    return surface === 'composer'
        ? requests
        : requests.filter(({ approval }) => approval.status !== 'open');
}
