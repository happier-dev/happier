import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationSelectors } from './actionOperationSelectors';
import { createActionOperationStore } from './actionOperationStore';

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1 as const,
        operationId: 'operation-a',
        revision: 1,
        actionId: 'session.spawn_new',
        state: 'accepted' as const,
        scope: {
            accountId: 'account-a',
            machineId: 'machine-a',
            sessionId: 'session-a',
        },
        title: 'Create session',
        createdAt: 100,
        cancellation: 'unsupported' as const,
        ...overrides,
    };
}

describe('action operation store', () => {
    it('marks only the requested terminal operation seen', () => {
        const store = createActionOperationStore();
        const first = operation({ operationId: 'operation-1', revision: 3, state: 'succeeded', settledAt: 130, result: { sessionId: 'session-1' } });
        const second = operation({ operationId: 'operation-2', revision: 4, state: 'failed', settledAt: 140, error: { errorCode: 'failed', error: 'Failed' } });
        store.mergeSnapshots([first, second]);

        expect(store.markTerminalSeen(first.operationId, 200)).toBe(true);
        expect(store.getSnapshot().seenAtByOperationId.get(first.operationId)).toEqual({ seenAt: 200, revision: 3 });
        expect(store.getSnapshot().seenAtByOperationId.has(second.operationId)).toBe(false);
        expect(store.markTerminalSeen(first.operationId, 300)).toBe(false);
    });

    it('keeps one row per operation ID across global and session selectors', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const accepted = operation();

        store.mergeSnapshots([accepted, accepted]);

        const state = store.getSnapshot();
        expect(selectors.selectAll(state).map((row) => row.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(state, 'session-a').map((row) => row.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(state, 'session-b')).toEqual([]);
    });

    it('keeps lifecycle monotonic and terminal snapshots immutable', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([operation()]);
        store.mergeSnapshots([operation({ revision: 2, state: 'running', startedAt: 110 })]);
        store.mergeSnapshots([operation({ revision: 3, state: 'succeeded', startedAt: 110, settledAt: 150, result: { sessionId: 'child' } })]);

        const terminal = selectors.selectAll(store.getSnapshot())[0]!.snapshot;

        store.mergeSnapshots([operation({ revision: 4, state: 'running', startedAt: 110 })]);
        store.mergeSnapshots([operation({ revision: 5, state: 'failed', startedAt: 110, settledAt: 160 })]);

        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot).toBe(terminal);
        expect(selectors.selectActive(store.getSnapshot())).toEqual([]);
    });

    it('projects unavailable observation without overwriting the canonical snapshot', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([operation({ revision: 2, state: 'running', startedAt: 110 })]);
        const canonical = selectors.selectAll(store.getSnapshot())[0]!.snapshot;

        store.setMachineObservation('machine-a', 'unavailable');

        const projected = selectors.selectAll(store.getSnapshot())[0]!;
        expect(projected.observation).toBe('unavailable');
        expect(projected.snapshot).toBe(canonical);
        expect(projected.snapshot.state).toBe('running');
    });

    it('dismisses only an unavailable nonterminal projection while retaining daemon truth', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const canonical = operation({ revision: 2, state: 'running', startedAt: 110 });
        store.mergeSnapshots([canonical]);

        expect(store.dismissUnavailable('operation-a')).toBe(false);
        store.reconcileMachineProjection({
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationIds: new Set(['operation-a']),
        });
        expect(store.dismissUnavailable('operation-a')).toBe(true);

        expect(selectors.selectAll(store.getSnapshot())).toEqual([]);
        expect(store.getSnapshot().operationsById.get('operation-a')).toBe(canonical);
        expect(store.getSnapshot().unavailableOperationIds.has('operation-a')).toBe(true);
        expect(store.dismissUnavailable('operation-a')).toBe(false);

        store.reconcileMachineProjection({
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [canonical],
            knownOperationIds: new Set(['operation-a']),
        });
        expect(selectors.selectAll(store.getSnapshot()).map((row) => row.snapshot.operationId))
            .toEqual(['operation-a']);
    });

    it('restores availability when a newer canonical snapshot arrives', () => {
        const store = createActionOperationStore();
        store.mergeSnapshots([operation()]);
        store.setMachineObservation('machine-a', 'unavailable');

        store.mergeSnapshots([operation({ revision: 2, state: 'running', startedAt: 110 })]);

        expect(store.getSnapshot().machineObservationById.get('machine-a')).toBe('available');
    });

    it('keeps selector references stable while their structural inputs are unchanged', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([operation()]);
        const before = store.getSnapshot();
        const allBefore = selectors.selectAll(before);
        const sessionBefore = selectors.selectForSession(before, 'session-a');

        store.mergeSnapshots([operation()]);

        const after = store.getSnapshot();
        expect(after).toBe(before);
        expect(selectors.selectAll(after)).toBe(allBefore);
        expect(selectors.selectForSession(after, 'session-a')).toBe(sessionBefore);
    });

    it('keeps unchanged row and scoped-list references stable across unrelated store updates', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([operation()]);
        const rowBefore = selectors.selectAll(store.getSnapshot())[0];
        const sessionBefore = selectors.selectForSession(store.getSnapshot(), 'session-a');

        store.mergeSnapshots([operation({
            operationId: 'operation-b',
            scope: {
                accountId: 'account-a',
                machineId: 'machine-b',
                sessionId: 'session-b',
            },
        })]);

        const allAfterMerge = selectors.selectAll(store.getSnapshot());
        expect(allAfterMerge.find((row) => row.snapshot.operationId === 'operation-a')).toBe(rowBefore);
        expect(selectors.selectForSession(store.getSnapshot(), 'session-a')).toBe(sessionBefore);

        store.markAllTerminalSeen(200);
        expect(selectors.selectAll(store.getSnapshot())).toBe(allAfterMerge);
    });

    it('marks current terminal rows seen but treats later settlement as unseen', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([operation({ revision: 2, state: 'succeeded', settledAt: 150 })]);

        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(true);
        store.markAllTerminalSeen(200);
        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(false);

        store.mergeSnapshots([
            operation({ operationId: 'operation-b', revision: 1, state: 'running', createdAt: 210 }),
        ]);
        store.markAllTerminalSeen(220);
        store.mergeSnapshots([
            operation({ operationId: 'operation-b', revision: 2, state: 'failed', createdAt: 210, settledAt: 230 }),
        ]);

        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(true);
        expect(selectors.selectHasAttention(store.getSnapshot())).toBe(true);
    });

    it('reconciles a complete daemon machine projection by retaining absent active rows as unavailable and pruning terminal rows', () => {
        const store = createActionOperationStore();
        const active = operation({ operationId: 'operation-active' });
        const terminal = operation({
            operationId: 'operation-terminal',
            revision: 2,
            state: 'succeeded',
            settledAt: 150,
        });
        store.mergeSnapshots([active, terminal]);

        store.reconcileMachineProjection({
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationIds: new Set([active.operationId, terminal.operationId]),
        });

        expect([...store.getSnapshot().operationsById.keys()]).toEqual([active.operationId]);
        expect(store.getSnapshot().machineObservationById.get('machine-a')).toBe('available');
        expect(createActionOperationSelectors().selectById(store.getSnapshot(), active.operationId)?.observation)
            .toBe('unavailable');
    });

    it('marks only an omitted active row unavailable when another active row is listed on the same machine', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const listed = operation({ operationId: 'operation-listed', state: 'running', revision: 2, startedAt: 110 });
        const omitted = operation({ operationId: 'operation-omitted', state: 'running', revision: 2, startedAt: 110 });
        store.mergeSnapshots([listed, omitted]);

        store.reconcileMachineProjection({
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [listed],
            knownOperationIds: new Set([listed.operationId, omitted.operationId]),
        });

        expect(selectors.selectById(store.getSnapshot(), listed.operationId)?.observation).toBe('available');
        expect(selectors.selectById(store.getSnapshot(), omitted.operationId)?.observation).toBe('unavailable');
        expect(store.dismissUnavailable(listed.operationId)).toBe(false);
        expect(store.dismissUnavailable(omitted.operationId)).toBe(true);
    });

    it('does not prune a concurrently accepted row that was not present when listing began', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const cached = operation({ operationId: 'operation-cached' });
        store.mergeSnapshots([cached]);
        const knownOperationIds = new Set(store.getSnapshot().operationsById.keys());
        const concurrent = operation({ operationId: 'operation-concurrent' });
        store.mergeSnapshots([concurrent]);

        store.reconcileMachineProjection({
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationIds,
        });

        expect([...store.getSnapshot().operationsById.keys()]).toEqual([
            cached.operationId,
            concurrent.operationId,
        ]);
        expect(selectors.selectById(store.getSnapshot(), cached.operationId)?.observation).toBe('unavailable');
        expect(selectors.selectById(store.getSnapshot(), concurrent.operationId)?.observation).toBe('available');
    });

    it('removes operation rows when their machine leaves the active account projection', () => {
        const store = createActionOperationStore();
        store.mergeSnapshots([
            operation({ operationId: 'removed-machine' }),
            operation({
                operationId: 'retained-machine',
                scope: { accountId: 'account-a', machineId: 'machine-b' },
            }),
        ]);

        store.retainAccountMachines('account-a', new Set(['machine-b']));

        expect([...store.getSnapshot().operationsById.keys()]).toEqual(['retained-machine']);
        expect(store.getSnapshot().machineObservationById.has('machine-a')).toBe(false);
    });

    it('dismisses only successful recent rows while retaining active and attention rows', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([
            operation({ operationId: 'active' }),
            operation({ operationId: 'success', revision: 2, state: 'succeeded', startedAt: 110, settledAt: 150 }),
            operation({ operationId: 'failed', revision: 2, state: 'failed', startedAt: 110, settledAt: 150, error: { errorCode: 'failed', error: 'Failed' } }),
        ]);

        expect(store.dismissRecentSucceeded()).toBe(true);

        expect(selectors.selectAll(store.getSnapshot()).map((row) => row.snapshot.operationId))
            .toEqual(['active', 'failed']);
        expect(store.getSnapshot().operationsById.has('success')).toBe(true);
        expect(store.dismissRecentSucceeded()).toBe(false);
    });

    it('overlays UI follow-up attention on daemon success without changing its canonical lifecycle', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        store.mergeSnapshots([operation({
            revision: 2,
            requestId: 'spawn-request',
            state: 'succeeded',
            startedAt: 110,
            settledAt: 150,
            result: { sessionId: 'created-session' },
        })]);

        store.markFollowUpNeedsAttention('spawn-request', 'Session created; setup needs attention');

        const projected = selectors.selectAll(store.getSnapshot())[0]!;
        expect(projected.snapshot.state).toBe('succeeded');
        expect(projected.followUpAttention).toBe('Session created; setup needs attention');
        expect(selectors.selectHasAttention(store.getSnapshot())).toBe(true);
    });
});
