import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol';
import { log } from '@/log';
import { getPersistenceStorage } from '../state/persistence';
import { serverAccountScopedStorageKey } from '../scope/serverAccountScope';

import {
    createActionOperationStore,
    type ActionOperationScope,
} from './actionOperationStore';
import {
    createActionOperationActivitySummarySelector,
    createInboxActionOperationEntriesSelector,
    createInboxActionOperationSummarySelector,
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
    it('records acknowledgement read and write failures in the production diagnostic log', () => {
        const scope = { serverId: 'acknowledgement-errors', accountId: primaryScope.accountId };
        const storage = getPersistenceStorage();
        const key = serverAccountScopedStorageKey('action-operation-acknowledgements-v1', scope);
        storage.set(key, '{');
        const beforeRead = log.getCount();
        const store = createActionOperationStore();
        store.activateScope(scope);
        expect(store.getState().dismissedOperationIds.size).toBe(0);
        expect(log.getLogs().slice(beforeRead)).toContain('[actionOperations] Could not load local acknowledgements (SyntaxError)');

        store.merge(snapshot({ revision: 2, state: 'failed' }));
        const beforeWrite = log.getCount();
        // MMKV is a persistent system boundary; simulate an unavailable write.
        const write = vi.spyOn(storage, 'set').mockImplementation(() => { throw new Error('Storage unavailable'); });
        try {
            store.dismissTerminal('operation-a');
            expect(log.getLogs().slice(beforeWrite)).toContain('[actionOperations] Could not save local acknowledgements (Error)');
        } finally {
            write.mockRestore();
            storage.delete(key);
        }
    });

    it('restores terminal acknowledgements before replay, isolates accounts and servers, and preserves active work', () => {
        const scope = { serverId: 'server-a', accountId: primaryScope.accountId };
        const store = createActionOperationStore();
        store.activateScope(scope);
        const success = snapshot({ operationId: 'success', revision: 2, state: 'succeeded' });
        const failure = snapshot({ operationId: 'failure', revision: 2, state: 'failed' });
        const active = snapshot({ operationId: 'active', revision: 1, state: 'running' });
        for (const operation of [success, failure, active]) store.merge(operation);
        store.markAccountTerminalSeen(scope.accountId, 2_000);
        store.dismissRecent(scope.accountId);
        store.markUnavailable(active.operationId);
        store.dismissUnavailable(active.operationId);

        const restarted = createActionOperationStore();
        restarted.activateScope(scope);
        for (const operation of [success, failure, active]) restarted.mergeFullSnapshot(operation);
        expect(restarted.getState().dismissedOperationIds).toEqual(new Set(['success']));
        expect(restarted.getState().terminalSeenAtById).toEqual(new Map([['success', 2_000], ['failure', 2_000]]));
        expect(restarted.getState().operationsById.get('failure')?.state).toBe('failed');
        expect(restarted.dismissTerminal('active')).toBe(false);
        expect(restarted.dismissTerminal('failure')).toBe(true);

        const afterDismiss = createActionOperationStore();
        afterDismiss.activateScope(scope);
        afterDismiss.mergeFullSnapshot(failure);
        expect(createActionOperationSelector(primaryScope)(afterDismiss.getState())).toEqual([]);
        expect(afterDismiss.getState().operationsById.get('failure')?.state).toBe('failed');
        afterDismiss.activateScope({ ...scope, serverId: 'server-b' });
        afterDismiss.mergeFullSnapshot(failure);
        expect(afterDismiss.getState().dismissedOperationIds.size).toBe(0);
        expect(afterDismiss.getState().terminalSeenAtById.size).toBe(0);
        afterDismiss.activateScope({ ...scope, accountId: 'account-b' });
        expect(afterDismiss.getState().operationsById.size).toBe(0);
        expect(afterDismiss.mergeFullSnapshot(failure)).toBe(false);
        afterDismiss.activateScope(scope);
        expect(afterDismiss.getState().dismissedOperationIds.has('failure')).toBe(true);
        // Complete machine lists also prune persisted decisions not yet replayed this run.
        afterDismiss.reconcileMachineList(primaryScope, new Set());
        const afterPrune = createActionOperationStore();
        afterPrune.activateScope(scope);
        expect(afterPrune.getState().dismissedOperationIds.size).toBe(0);
        expect(afterPrune.getState().terminalSeenAtById.size).toBe(0);
    });

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
        const selectAction = createActionOperationSelector({ ...primaryScope, sessionId: 'session-a', actionId: 'session.spawn_new' });
        const actionBefore = selectAction(store.getState());
        store.merge({ ...snapshot({ operationId: 'other-action', revision: 1, state: 'running', sessionId: 'session-a' }), actionId: 'session.direct.takeover_persist' });
        expect(selectAction(store.getState())).toBe(actionBefore);
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

    it('keeps routine operation activity out of Inbox while retaining it in Activity history', () => {
        const store = createActionOperationStore();
        const selectActivity = createActionOperationSelector(primaryScope);
        const selectInbox = createInboxActionOperationEntriesSelector(primaryScope.accountId);
        const running = snapshot({ operationId: 'running', revision: 2, state: 'running' });
        store.merge(running);
        const succeeded = snapshot({ operationId: 'succeeded', revision: 3, state: 'succeeded' });
        const cancelled = snapshot({ operationId: 'cancelled', revision: 3, state: 'cancelled' });
        store.merge(succeeded);
        store.merge(cancelled);

        expect(selectInbox(store.getState())).toEqual([]);
        expect(selectActivity(store.getState())).toEqual([running, succeeded, cancelled]);

        // Scope-level observation belongs to Activity connectivity status. Inbox
        // admits only an individually unavailable operation that its X action can
        // actually dismiss through the canonical store lifecycle.
        store.setObservation(primaryScope, 'status_unavailable');
        expect(selectInbox(store.getState())).toEqual([]);
    });

    it('projects a stable closed-Activity summary without exposing detail collections', () => {
        const store = createActionOperationStore();
        let setupNeedsAttention = true;
        const selectSummary = createActionOperationActivitySummarySelector(
            primaryScope.accountId,
            (operation) => operation.operationId === 'setup' && setupNeedsAttention
                ? { kind: 'setup_needs_attention' }
                : null,
        );
        const running = snapshot({ operationId: 'running', revision: 1, state: 'running' });
        const unavailable = snapshot({ operationId: 'unavailable', revision: 1, state: 'running' });
        const setup = snapshot({ operationId: 'setup', revision: 1, state: 'succeeded' });
        store.merge(running);
        store.merge(unavailable);
        store.merge(setup);
        store.markSeen(setup.operationId);
        store.markUnavailable(unavailable.operationId);

        const before = selectSummary(store.getState());
        expect(before).toEqual({ activeCount: 1, hasAttention: true });

        store.merge(snapshot({
            operationId: 'other-account',
            revision: 1,
            state: 'running',
            accountId: 'account-b',
        }));
        expect(selectSummary(store.getState())).toBe(before);

        expect(store.dismissUnavailable(unavailable.operationId)).toBe(true);
        expect(store.dismissUnavailable(running.operationId)).toBe(false);
        store.setObservation(primaryScope, 'status_unavailable');
        expect(selectSummary(store.getState())).toEqual({ activeCount: 0, hasAttention: true });

        setupNeedsAttention = false;
        expect(store.merge(snapshot({ operationId: running.operationId, revision: 2, state: 'succeeded' }))).toBe(true);
        expect(store.markSeen(running.operationId)).toBe(true);
        expect(selectSummary(store.getState())).toEqual({ activeCount: 0, hasAttention: false });
    });

    it('projects only resolvable operation attention into Inbox and removes acknowledged or dismissed rows', () => {
        const store = createActionOperationStore();
        let setupNeedsAttention = true;
        const selectInbox = createInboxActionOperationEntriesSelector(primaryScope.accountId, (operation) => (
            operation.operationId === 'setup' && setupNeedsAttention ? { kind: 'setup_needs_attention' } : null
        ));
        const running = snapshot({ operationId: 'running', revision: 2, state: 'running' });
        const unavailable = snapshot({ operationId: 'unavailable', revision: 2, state: 'running' });
        const failed = snapshot({ operationId: 'failed', revision: 3, state: 'failed' });
        const setup = snapshot({ operationId: 'setup', revision: 3, state: 'succeeded' });
        store.merge(running);
        store.merge(unavailable);
        store.merge(failed);
        store.merge(setup);
        store.markUnavailable(unavailable.operationId);

        expect(selectInbox(store.getState()).map((entry) => [entry.operation.operationId, entry.reason])).toEqual([
            ['unavailable', 'status_unavailable'],
            ['failed', 'failed'],
            ['setup', 'setup_needs_attention'],
        ]);

        expect(store.dismissUnavailable(unavailable.operationId)).toBe(true);
        expect(store.markSeen(failed.operationId, 1_600)).toBe(true);
        expect(store.markSeen(setup.operationId, 1_600)).toBe(true);

        // Terminal seen state and the follow-up setup workflow are distinct.
        // A setup failure that arrives after the result was seen remains actionable.
        expect(selectInbox(store.getState()).map((entry) => [entry.operation.operationId, entry.reason])).toEqual([
            ['setup', 'setup_needs_attention'],
        ]);
        setupNeedsAttention = false;
        expect(selectInbox(store.getState())).toEqual([]);
    });

    it('projects a stable exact Inbox operation summary through the shared entry classification', () => {
        const store = createActionOperationStore();
        let setupNeedsAttention = true;
        const resolveLocalPresentation = (operation: ActionOperationSnapshotV1) => (
            operation.operationId === 'setup' && setupNeedsAttention
                ? { kind: 'setup_needs_attention' as const }
                : null
        );
        const selectEntries = createInboxActionOperationEntriesSelector(
            primaryScope.accountId,
            resolveLocalPresentation,
        );
        const selectSummary = createInboxActionOperationSummarySelector(
            primaryScope.accountId,
            resolveLocalPresentation,
        );
        const routine = snapshot({ operationId: 'routine', revision: 1, state: 'running' });
        const unavailable = snapshot({ operationId: 'unavailable', revision: 1, state: 'accepted' });
        const failed = snapshot({ operationId: 'failed', revision: 1, state: 'failed' });
        const setup = snapshot({ operationId: 'setup', revision: 1, state: 'succeeded' });
        store.merge(routine);
        store.merge(unavailable);
        store.merge(failed);
        store.merge(setup);
        store.markSeen(setup.operationId);
        store.markUnavailable(unavailable.operationId);

        const before = selectSummary(store.getState());
        expect(before).toEqual({ count: 3, hasAttention: true });
        expect(before.count).toBe(selectEntries(store.getState()).length);

        store.merge(snapshot({
            operationId: 'other-account',
            revision: 1,
            state: 'failed',
            accountId: 'account-b',
        }));
        expect(selectSummary(store.getState())).toBe(before);

        expect(store.dismissUnavailable(unavailable.operationId)).toBe(true);
        expect(store.markSeen(failed.operationId)).toBe(true);
        setupNeedsAttention = false;
        expect(selectSummary(store.getState())).toEqual({ count: 0, hasAttention: false });
        expect(selectEntries(store.getState())).toEqual([]);
    });

    it('marks only the active account terminal operations seen in one store transition', () => {
        const store = createActionOperationStore();
        store.merge(snapshot({ operationId: 'running', revision: 1, state: 'running' }));
        store.merge(snapshot({ operationId: 'complete-a', revision: 1, state: 'succeeded' }));
        store.merge(snapshot({ operationId: 'complete-b', revision: 1, state: 'failed' }));
        store.merge(snapshot({
            operationId: 'other-account',
            revision: 1,
            state: 'failed',
            accountId: 'account-b',
        }));
        let publications = 0;
        store.subscribe(() => { publications += 1; });

        expect(store.markAccountTerminalSeen(primaryScope.accountId, 500)).toBe(true);
        expect(publications).toBe(1);
        expect(Array.from(store.getState().terminalSeenAtById.keys()).sort()).toEqual(['complete-a', 'complete-b']);
        expect(store.getState().terminalSeenAtById.has('running')).toBe(false);
        expect(store.getState().terminalSeenAtById.has('other-account')).toBe(false);
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
