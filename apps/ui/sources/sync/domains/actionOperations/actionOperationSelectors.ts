import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol';

import {
    actionOperationScopeKey,
    type ActionOperationObservation,
    type ActionOperationScope,
    type ActionOperationStoreState,
} from './actionOperationStore';

type ActionOperationSelectorScope = ActionOperationScope & Readonly<{
    sessionId?: string;
    actionId?: string;
    states?: readonly ActionOperationStateV1[];
}>;

export type InboxActionOperationReason = 'failed' | 'status_unavailable' | 'setup_needs_attention';

export type InboxActionOperationEntry = Readonly<{
    operation: ActionOperationSnapshotV1;
    reason: InboxActionOperationReason;
}>;

export type ActionOperationActivitySummary = Readonly<{
    activeCount: number;
    hasAttention: boolean;
}>;

export type InboxActionOperationSummary = Readonly<{
    count: number;
    hasAttention: boolean;
}>;

type ResolveActionOperationLocalPresentation = (
    operation: ActionOperationSnapshotV1,
) => Readonly<{ kind: 'setup_needs_attention' }> | null;

const NO_LOCAL_PRESENTATION: ResolveActionOperationLocalPresentation = () => null;

/** The one answer to "is this Action still running": every surface that shows live work reads it. */
export function isActionOperationInFlight(operation: ActionOperationSnapshotV1 | null | undefined): boolean {
    return operation?.state === 'accepted' || operation?.state === 'running';
}

export function isActionOperationCancellationRequested(operation: ActionOperationSnapshotV1 | null | undefined): boolean {
    return operation?.state === 'running' && operation.progress?.kind === 'phase' && operation.progress.phase === 'cancelling';
}

function sameReferences(
    previous: readonly ActionOperationSnapshotV1[],
    next: readonly ActionOperationSnapshotV1[],
): boolean {
    return previous.length === next.length && previous.every((item, index) => item === next[index]);
}

export function createActionOperationSelector(scope: ActionOperationSelectorScope) {
    const states = scope.states ? new Set(scope.states) : null;
    let previous: readonly ActionOperationSnapshotV1[] = [];

    return (state: ActionOperationStoreState): readonly ActionOperationSnapshotV1[] => {
        const next = Array.from(state.operationsById.values()).filter((operation) => (
            operation.scope.accountId === scope.accountId
            && operation.scope.machineId === scope.machineId
            && !state.dismissedOperationIds.has(operation.operationId)
            && (scope.sessionId === undefined || operation.scope.sessionId === scope.sessionId)
            && (scope.actionId === undefined || operation.actionId === scope.actionId)
            && (states === null || states.has(operation.state))
        ));
        if (sameReferences(previous, next)) return previous;
        previous = next;
        return previous;
    };
}

export function selectActionOperationObservation(
    state: ActionOperationStoreState,
    scope: ActionOperationScope,
): ActionOperationObservation {
    return state.observationByScope.get(actionOperationScopeKey(scope)) ?? 'available';
}

export function selectActionOperationObservationForOperation(
    state: ActionOperationStoreState,
    operation: ActionOperationSnapshotV1,
): ActionOperationObservation {
    const scopeObservation = selectActionOperationObservation(state, operation.scope);
    if (scopeObservation !== 'available') return scopeObservation;
    return state.unavailableOperationIds.has(operation.operationId) ? 'status_unavailable' : 'available';
}

function sameInboxEntries(
    previous: readonly InboxActionOperationEntry[],
    next: readonly InboxActionOperationEntry[],
): boolean {
    return previous.length === next.length && previous.every((entry, index) => (
        entry.operation === next[index]?.operation && entry.reason === next[index]?.reason
    ));
}

function selectInboxActionOperationReason(
    state: ActionOperationStoreState,
    operation: ActionOperationSnapshotV1,
    resolveLocalPresentation: ResolveActionOperationLocalPresentation,
): InboxActionOperationReason | null {
    if (state.dismissedOperationIds.has(operation.operationId)) return null;
    if (
        operation.state === 'failed'
        && !state.terminalSeenAtById.has(operation.operationId)
    ) {
        return 'failed';
    }
    if (
        operation.state === 'succeeded'
        && resolveLocalPresentation(operation)?.kind === 'setup_needs_attention'
    ) {
        return 'setup_needs_attention';
    }
    if (
        isActionOperationInFlight(operation)
        && state.unavailableOperationIds.has(operation.operationId)
    ) {
        return 'status_unavailable';
    }
    return null;
}

/**
 * Projects only operation states that require an Inbox response. Routine lifecycle
 * activity remains available through the unfiltered Activity selectors.
 */
export function createInboxActionOperationEntriesSelector(
    accountId: string,
    resolveLocalPresentation: ResolveActionOperationLocalPresentation = NO_LOCAL_PRESENTATION,
) {
    let previous: readonly InboxActionOperationEntry[] = [];
    return (state: ActionOperationStoreState): readonly InboxActionOperationEntry[] => {
        const next: InboxActionOperationEntry[] = [];
        for (const operation of state.operationsById.values()) {
            if (
                operation.scope.accountId !== accountId
            ) {
                continue;
            }
            const reason = selectInboxActionOperationReason(state, operation, resolveLocalPresentation);
            if (reason) next.push({ operation, reason });
        }

        if (sameInboxEntries(previous, next)) return previous;
        previous = next;
        return previous;
    };
}

/** Projects Inbox operation lifecycle state without allocating entry rows. */
export function createInboxActionOperationSummarySelector(
    accountId: string,
    resolveLocalPresentation: ResolveActionOperationLocalPresentation = NO_LOCAL_PRESENTATION,
) {
    let previous: InboxActionOperationSummary = { count: 0, hasAttention: false };
    return (state: ActionOperationStoreState): InboxActionOperationSummary => {
        let count = 0;
        for (const operation of state.operationsById.values()) {
            if (operation.scope.accountId !== accountId) continue;
            if (selectInboxActionOperationReason(state, operation, resolveLocalPresentation)) count += 1;
        }
        if (previous.count === count) return previous;
        previous = { count, hasAttention: count > 0 };
        return previous;
    };
}

function actionOperationNeedsActivityAttention(
    state: ActionOperationStoreState,
    operation: ActionOperationSnapshotV1,
    resolveLocalPresentation: ResolveActionOperationLocalPresentation,
): boolean {
    if (state.dismissedOperationIds.has(operation.operationId)) return false;
    if (isActionOperationInFlight(operation)) return true;
    if (!state.terminalSeenAtById.has(operation.operationId)) return true;
    return resolveLocalPresentation(operation)?.kind === 'setup_needs_attention';
}

export function selectActionOperationsNeedAttention(
    state: ActionOperationStoreState,
    accountId: string,
): boolean {
    for (const operation of state.operationsById.values()) {
        if (operation.scope.accountId !== accountId) continue;
        if (actionOperationNeedsActivityAttention(state, operation, NO_LOCAL_PRESENTATION)) return true;
    }
    return false;
}

/**
 * Projects the stable, minimal state needed by a closed Activity button. Detail
 * collections and presentation context remain outside this selector so they can
 * subscribe only while the popover is mounted.
 */
export function createActionOperationActivitySummarySelector(
    accountId: string,
    resolveLocalPresentation: ResolveActionOperationLocalPresentation = NO_LOCAL_PRESENTATION,
) {
    let previous: ActionOperationActivitySummary = { activeCount: 0, hasAttention: false };
    return (state: ActionOperationStoreState): ActionOperationActivitySummary => {
        let activeCount = 0;
        let hasAttention = false;

        for (const operation of state.operationsById.values()) {
            if (
                operation.scope.accountId !== accountId
                || state.dismissedOperationIds.has(operation.operationId)
            ) {
                continue;
            }

            if (actionOperationNeedsActivityAttention(state, operation, resolveLocalPresentation)) {
                hasAttention = true;
            }

            if (isActionOperationInFlight(operation)) {
                const scopeObservation = selectActionOperationObservation(state, operation.scope);
                if (
                    scopeObservation !== 'status_unavailable'
                    && !state.unavailableOperationIds.has(operation.operationId)
                ) {
                    activeCount += 1;
                }
            }
        }

        if (previous.activeCount === activeCount && previous.hasAttention === hasAttention) {
            return previous;
        }
        previous = { activeCount, hasAttention };
        return previous;
    };
}
