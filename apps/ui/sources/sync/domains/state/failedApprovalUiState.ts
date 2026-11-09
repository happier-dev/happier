import { z } from 'zod/mini';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createPersistentUiState, UiStatePersistenceError } from './persistentUiState';

export const failedApprovalDismissalsState = createPersistentUiState('failed-approval-dismissals-v1',
    value => z.catch(z.record(z.string(), z.number()), {}).parse(value));
export const EMPTY_FAILED_APPROVAL_DISMISSALS: Readonly<Record<string, number>> = Object.freeze({});

export function failedApprovalDismissalScopeKey(scope: ServerAccountScope): string {
    return JSON.stringify([scope.serverId, scope.accountId]);
}

/** Refused reads abort the mutation; callers present the typed persistence failure. */
export function dismissFailedApproval(scopeKey: string, artifactId: string): void {
    const previous = failedApprovalDismissalsState.readStrict(scopeKey) ?? EMPTY_FAILED_APPROVAL_DISMISSALS;
    if (Object.hasOwn(previous, artifactId)) return;
    failedApprovalDismissalsState.set(scopeKey, { ...previous, [artifactId]: Date.now() });
}

/** Full inventory currentness can retire records even after an unreadable projection withdrew them. */
export function reconcileFailedApprovalDismissals(
    scope: ServerAccountScope | null | undefined,
    isPresent: (artifactId: string) => boolean,
): void {
    if (!scope) return;
    const previous = failedApprovalDismissalsState.read(failedApprovalDismissalScopeKey(scope));
    if (!previous) return;
    const missingIds = Object.keys(previous).filter(id => !isPresent(id));
    if (missingIds.length > 0) retireFailedApprovalDismissals(scope, missingIds);
}

/** Only actual Artifact retirement withdraws a remembered dismissal; absence from a view does not. */
export function retireFailedApprovalDismissals(scope: ServerAccountScope | null | undefined, artifactIds: Iterable<string>): void {
    if (!scope) return;
    const key = failedApprovalDismissalScopeKey(scope);
    const previous = failedApprovalDismissalsState.read(key);
    if (!previous) return;
    let remaining = previous;
    for (const artifactId of artifactIds) {
        if (!Object.hasOwn(remaining, artifactId)) continue;
        if (remaining === previous) remaining = { ...previous };
        delete remaining[artifactId];
    }
    if (remaining === previous) return;
    try {
        if (Object.keys(remaining).length > 0) failedApprovalDismissalsState.set(key, remaining);
        else failedApprovalDismissalsState.remove(key);
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[approvals] Dismissal retirement could not be persisted.');
    }
}
