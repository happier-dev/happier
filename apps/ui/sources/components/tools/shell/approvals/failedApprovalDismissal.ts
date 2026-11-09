import * as React from 'react';

import type { OpenApprovalAttentionArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import {
    dismissFailedApproval,
    EMPTY_FAILED_APPROVAL_DISMISSALS,
    failedApprovalDismissalsState,
    failedApprovalDismissalScopeKey,
} from '@/sync/domains/state/failedApprovalUiState';
import { UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
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
    return React.useMemo(
        () => requests.filter(({ artifact, approval }) => approval.status === 'open'
            || dismissed[artifact.id] === undefined),
        [dismissed, requests],
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
