import { describe, expect, it } from 'vitest';

import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol';

import {
    createActionOperationStore,
    type ActionOperationScope,
} from './actionOperationStore';
import {
    createActionOperationSelector,
    selectActionOperationObservation,
    selectActionOperationObservationForOperation,
    selectActionOperationsNeedAttention,
} from './actionOperationSelectors';

const primaryScope: ActionOperationScope = {
    accountId: 'account-a',
    machineId: 'machine-a',
};

function snapshot(params: Readonly<{
    operationId?: string;
    revision: number;
    state: ActionOperationStateV1;
    sessionId?: string;
    accountId?: string;
    machineId?: string;
}>): ActionOperationSnapshotV1 {
    const settledAt = params.state === 'succeeded' || params.state === 'failed' || params.state === 'cancelled'
        ? 1_500
        : undefined;
    return {
        version: 1,
        revision: params.revision,
        operationId: params.operationId ?? 'operation-a',
        actionId: 'session.spawn_new',
        state: params.state,
        scope: {
            accountId: params.accountId ?? primaryScope.accountId,
            machineId: params.machineId ?? primaryScope.machineId,
            sessionId: params.sessionId,
        },
        title: 'Create session',
        createdAt: 1_000,
        startedAt: params.state === 'accepted' ? undefined : 1_100,
        settledAt,
        progress: params.state === 'running' ? { kind: 'phase', phase: 'creating', label: 'Creating' } : undefined,
        cancellation: 'unsupported',
    };
}

describe('actionOperationStore', () => {
    it('merges revisions monotonically and never regresses or changes a terminal lifecycle', () => {
        const store = createActionOperationStore();

        expect(store.merge(snapshot({ revision: 1, state: 'accepted' }))).toBe(true);
        expect(store.merge(snapshot({ revision: 3, state: 'running' }))).toBe(true);
        expect(store.merge(snapshot({ revision: 2, state: 'accepted' }))).toBe(false);
        expect(store.merge(snapshot({ revision: 4, state: 'accepted' }))).toBe(false);
        expect(store.getState().operationsById.get('operation-a')?.state).toBe('running');

        expect(store.merge(snapshot({ revision: 5, state: 'succeeded' }))).toBe(true);
        const terminal = store.getState().operationsById.get('operation-a');
        expect(store.merge(snapshot({ revision: 6, state: 'running' }))).toBe(false);
        expect(store.merge(snapshot({ revision: 6, state: 'failed' }))).toBe(false);
        expect(store.getState().operationsById.get('operation-a')).toBe(terminal);
    });

    it('returns one shared operation through stable global and session-scoped selectors', () => {
        const store = createActionOperationStore();
        const selectAll = createActionOperationSelector(primaryScope);
        const selectSession = createActionOperationSelector({ ...primaryScope, sessionId: 'session-a' });
        store.merge(snapshot({ revision: 1, state: 'running', sessionId: 'session-a' }));

        const allBefore = selectAll(store.getState());
        const sessionBefore = selectSession(store.getState());
        expect(allBefore).toHaveLength(1);
        expect(sessionBefore).toHaveLength(1);
        expect(sessionBefore[0]).toBe(allBefore[0]);

        store.merge(snapshot({
            operationId: 'operation-b',
            revision: 1,
            state: 'running',
            sessionId: 'session-b',
            accountId: 'account-b',
            machineId: 'machine-b',
        }));

        expect(selectAll(store.getState())).toBe(allBefore);
        expect(selectSession(store.getState())).toBe(sessionBefore);
    });

    it('projects unavailable observation separately without corrupting the canonical snapshot', () => {
        const store = createActionOperationStore();
        const selectAll = createActionOperationSelector(primaryScope);
        const succeeded = snapshot({ revision: 5, state: 'succeeded' });
        store.merge(succeeded);
        const rowsBefore = selectAll(store.getState());

        store.setObservation(primaryScope, 'status_unavailable');

        expect(selectActionOperationObservation(store.getState(), primaryScope)).toBe('status_unavailable');
        expect(store.getState().operationsById.get(succeeded.operationId)).toBe(succeeded);
        expect(selectAll(store.getState())).toBe(rowsBefore);

        expect(store.merge(snapshot({ revision: 4, state: 'running' }))).toBe(false);
        expect(store.getState().operationsById.get(succeeded.operationId)).toBe(succeeded);
    });

    it('enriches a lightweight terminal list row from a full same-revision detail snapshot', () => {
        const store = createActionOperationStore();
        const lightweight = snapshot({ revision: 5, state: 'succeeded' });
        const full = { ...lightweight, result: { type: 'success', sessionId: 'session-created' } };
        store.merge(lightweight);

        expect(store.mergeFullSnapshot(full)).toBe(true);
        expect(store.getState().operationsById.get(lightweight.operationId)).toBe(full);
        expect(store.mergeFullSnapshot({ ...full, state: 'failed' })).toBe(false);
    });

    it('prunes settled rows omitted by a complete daemon list while retaining missing active truth as unavailable', () => {
        const store = createActionOperationStore();
        const active = snapshot({ operationId: 'active', revision: 2, state: 'running' });
        const listedActive = snapshot({ operationId: 'listed-active', revision: 2, state: 'running' });
        const retained = snapshot({ operationId: 'retained', revision: 3, state: 'succeeded' });
        const pruned = snapshot({ operationId: 'pruned', revision: 4, state: 'failed' });
        const otherMachine = snapshot({
            operationId: 'other-machine',
            revision: 3,
            state: 'succeeded',
            machineId: 'machine-b',
        });
        store.merge(active);
        store.merge(listedActive);
        store.merge(retained);
        store.merge(pruned);
        store.merge(otherMachine);
        store.markSeen(pruned.operationId, 1_600);

        expect(store.reconcileMachineList(primaryScope, new Set(['listed-active', 'retained']))).toEqual({ missingActive: true });
        expect(store.getState().operationsById.has('active')).toBe(true);
        expect(store.getState().operationsById.has('retained')).toBe(true);
        expect(store.getState().operationsById.has('pruned')).toBe(false);
        expect(store.getState().operationsById.has('other-machine')).toBe(true);
        expect(store.getState().terminalSeenAtById.has('pruned')).toBe(false);
        expect(selectActionOperationObservation(store.getState(), primaryScope)).toBe('available');
        expect(selectActionOperationObservationForOperation(store.getState(), active)).toBe('status_unavailable');
        expect(selectActionOperationObservationForOperation(store.getState(), listedActive)).toBe('available');
        expect(store.dismissUnavailable('listed-active')).toBe(false);
    });

    it('dismisses only an unavailable active projection without claiming it settled', () => {
        const store = createActionOperationStore();
        const selectAll = createActionOperationSelector(primaryScope);
        const active = snapshot({ operationId: 'active', revision: 2, state: 'running' });
        const settled = snapshot({ operationId: 'settled', revision: 3, state: 'succeeded' });
        store.merge(active);
        store.merge(settled);

        expect(store.dismissUnavailable('active')).toBe(false);
        store.reconcileMachineList(primaryScope, new Set(['settled']));
        expect(store.dismissUnavailable('settled')).toBe(false);
        expect(store.dismissUnavailable('active')).toBe(true);
        expect(selectAll(store.getState())).toEqual([settled]);
        expect(store.getState().operationsById.get('active')).toBe(active);
        expect(store.dismissUnavailable('active')).toBe(false);
    });

    it('keeps active and newly completed operations in Inbox attention until terminal detail is seen', () => {
        const store = createActionOperationStore();
        const running = snapshot({ revision: 2, state: 'running' });
        store.merge(running);

        expect(selectActionOperationsNeedAttention(store.getState(), primaryScope.accountId)).toBe(true);
        expect(store.markSeen(running.operationId, 1_400)).toBe(false);
        expect(selectActionOperationsNeedAttention(store.getState(), primaryScope.accountId)).toBe(true);

        const succeeded = snapshot({ revision: 3, state: 'succeeded' });
        store.merge(succeeded);
        expect(selectActionOperationsNeedAttention(store.getState(), primaryScope.accountId)).toBe(true);

        expect(store.markSeen(succeeded.operationId, 1_600)).toBe(true);
        expect(selectActionOperationsNeedAttention(store.getState(), primaryScope.accountId)).toBe(false);
        expect(store.getState().operationsById.get(succeeded.operationId)).toBe(succeeded);
    });

    it('marks all currently visible terminal operations seen in one store transition', () => {
        const store = createActionOperationStore();
        store.merge(snapshot({ operationId: 'running', revision: 1, state: 'running' }));
        store.merge(snapshot({ operationId: 'complete-a', revision: 1, state: 'succeeded' }));
        store.merge(snapshot({ operationId: 'complete-b', revision: 1, state: 'failed' }));
        let publications = 0;
        store.subscribe(() => { publications += 1; });

        expect(store.markAllTerminalSeen(500)).toBe(true);
        expect(publications).toBe(1);
        expect(Array.from(store.getState().terminalSeenAtById.keys()).sort()).toEqual(['complete-a', 'complete-b']);
        expect(store.getState().terminalSeenAtById.has('running')).toBe(false);
    });

    it('dismisses only local recent rows without deleting daemon truth or hiding active and failed rows', () => {
        const store = createActionOperationStore();
        const selectAll = createActionOperationSelector(primaryScope);
        store.merge(snapshot({ operationId: 'running', revision: 1, state: 'running' }));
        store.merge(snapshot({ operationId: 'failed', revision: 1, state: 'failed' }));
        store.merge(snapshot({ operationId: 'succeeded', revision: 1, state: 'succeeded' }));
        store.merge(snapshot({ operationId: 'cancelled', revision: 1, state: 'cancelled' }));
        store.merge(snapshot({ operationId: 'protected-success', revision: 1, state: 'succeeded' }));
        store.merge(snapshot({
            operationId: 'other-account',
            revision: 1,
            state: 'succeeded',
            accountId: 'account-b',
            machineId: 'machine-b',
        }));

        expect(store.dismissRecent(primaryScope.accountId, {
            preserveOperationIds: new Set(['protected-success']),
        })).toBe(true);
        expect(selectAll(store.getState()).map((operation) => operation.operationId)).toEqual(['running', 'failed', 'protected-success']);
        expect(store.getState().operationsById.has('succeeded')).toBe(true);
        expect(store.getState().operationsById.has('cancelled')).toBe(true);
        expect(store.getState().dismissedOperationIds.has('protected-success')).toBe(false);
        expect(store.getState().operationsById.has('other-account')).toBe(true);
        expect(Array.from(store.getState().dismissedOperationIds).sort()).toEqual(['cancelled', 'succeeded']);
        expect(selectActionOperationsNeedAttention(store.getState(), primaryScope.accountId)).toBe(true);
    });
});
