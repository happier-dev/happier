import * as React from 'react';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import {
    useActiveServerAccountScope,
    useAllMachines,
    useAllSessionListRenderables,
    useAllSessions,
} from '@/sync/domains/state/storage';
import {
    useActionOperationObservations,
    useActionOperationsNeedAttention,
    useAllActionOperations,
    useInboxActionOperationEntries,
    useUnavailableActionOperationIds,
} from '@/sync/domains/actionOperations/useActionOperations';
import type { InboxActionOperationEntry } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationReentry } from '@/sync/domains/actionOperations/actionOperationReentry';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    getSessionDisplayTitle,
    getSessionName,
    type SessionNameSource,
} from '@/utils/sessions/sessionUtils';

import type { ActionOperationObservationPresentation } from './actionOperationPresentation';

export type ActionOperationActivityModel = Readonly<{
    operations: readonly ActionOperationSnapshotV1[];
    inboxEntries: readonly InboxActionOperationEntry[];
    activeCount: number;
    hasAttention: boolean;
    observationForOperation: (operation: ActionOperationSnapshotV1) => ActionOperationObservationPresentation;
    contextForOperation: (operation: ActionOperationSnapshotV1) => string | null;
    clearRecent: () => void;
    canDismissOperation: (operation: ActionOperationSnapshotV1) => boolean;
    dismissOperation: (operationId: string) => void;
}>;

export function resolveActionOperationSessionNameById(
    sessions: readonly SessionNameSource[],
    sessionListRenderables: readonly SessionNameSource[],
): ReadonlyMap<string, string> {
    const resolved = new Map<string, string>();
    for (const renderable of sessionListRenderables) {
        resolved.set(renderable.id, getSessionName(renderable));
    }
    for (const session of sessions) {
        const explicitTitle = getSessionDisplayTitle(session);
        if (explicitTitle) {
            resolved.set(session.id, explicitTitle);
        } else if (!resolved.has(session.id)) {
            resolved.set(session.id, getSessionName(session));
        }
    }
    return resolved;
}

export function useActionOperationActivityModel(): ActionOperationActivityModel {
    const accountId = useActiveServerAccountScope()?.accountId ?? '';
    const operations = useAllActionOperations(accountId);
    const inboxEntries = useInboxActionOperationEntries(accountId);
    const observations = useActionOperationObservations(accountId);
    const unavailableOperationIds = useUnavailableActionOperationIds(accountId);
    const storeHasAttention = useActionOperationsNeedAttention(accountId);
    const reentryRevision = React.useSyncExternalStore(
        actionOperationReentry.subscribe,
        actionOperationReentry.getRevision,
        actionOperationReentry.getRevision,
    );
    const sessions = useAllSessions();
    const sessionListRenderables = useAllSessionListRenderables();
    const machines = useAllMachines();
    const sessionNameById = React.useMemo(
        () => resolveActionOperationSessionNameById(sessions, sessionListRenderables),
        [sessionListRenderables, sessions],
    );
    const machineById = React.useMemo(
        () => new Map(machines.map((machine) => [machine.id, machine])),
        [machines],
    );
    const activeCount = React.useMemo(
        () => operations.reduce(
            (count, operation) => count + (
                (operation.state === 'accepted' || operation.state === 'running')
                && observations.get(operation.scope.machineId) !== 'status_unavailable'
                && !unavailableOperationIds.has(operation.operationId)
                    ? 1
                    : 0
            ),
            0,
        ),
        [observations, operations, unavailableOperationIds],
    );
    const hasAttention = React.useMemo(
        () => storeHasAttention || operations.some(
            (operation) => actionOperationReentry.resolvePresentation(operation)?.kind === 'setup_needs_attention',
        ),
        [operations, reentryRevision, storeHasAttention],
    );
    const observationForOperation = React.useCallback(
        (operation: ActionOperationSnapshotV1): ActionOperationObservationPresentation => {
            const scopeObservation = observations.get(operation.scope.machineId) ?? 'available';
            if (scopeObservation !== 'available') return scopeObservation;
            return unavailableOperationIds.has(operation.operationId) ? 'status_unavailable' : 'available';
        },
        [observations, unavailableOperationIds],
    );
    const contextForOperation = React.useCallback((operation: ActionOperationSnapshotV1): string | null => {
        if (operation.scope.sessionId) {
            return sessionNameById.get(operation.scope.sessionId) ?? null;
        }
        const machine = machineById.get(operation.scope.machineId);
        return machine ? getMachineDisplayName(machine) : null;
    }, [machineById, sessionNameById]);
    const clearRecent = React.useCallback(() => {
        if (!accountId) return;
        const preserveOperationIds = new Set(
            operations
                .filter((operation) => actionOperationReentry.resolvePresentation(operation)?.kind === 'setup_needs_attention')
                .map((operation) => operation.operationId),
        );
        actionOperationStore.dismissRecent(accountId, { preserveOperationIds });
    }, [accountId, operations]);
    const dismissOperation = React.useCallback((operationId: string) => {
        const operation = operations.find((candidate) => candidate.operationId === operationId);
        if (!operation) return;
        const entry = inboxEntries.find((candidate) => candidate.operation.operationId === operationId);
        if (entry?.reason === 'setup_needs_attention') {
            actionOperationReentry.acknowledgeSetupNeedsAttention(entry.operation);
            actionOperationStore.markSeen(operationId);
            return;
        }
        if (operation.state === 'failed') {
            actionOperationStore.dismissTerminal(operationId);
        } else {
            actionOperationStore.dismissUnavailable(operationId);
        }
    }, [inboxEntries, operations]);
    const canDismissOperation = React.useCallback(
        (operation: ActionOperationSnapshotV1) => operation.state === 'failed' || inboxEntries.some(
            (entry) => entry.operation.operationId === operation.operationId,
        ),
        [inboxEntries],
    );

    return React.useMemo(() => ({
        operations,
        inboxEntries,
        activeCount,
        hasAttention,
        observationForOperation,
        contextForOperation,
        clearRecent,
        canDismissOperation,
        dismissOperation,
    }), [
        activeCount,
        contextForOperation,
        hasAttention,
        clearRecent,
        canDismissOperation,
        dismissOperation,
        observationForOperation,
        operations,
        inboxEntries,
    ]);
}
