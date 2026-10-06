import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationSelectors } from './actionOperationSelectors';
import { createActionOperationStore, type ActionOperationStore } from './actionOperationStore';
import { actionOperationAddressKey, actionOperationMachineAddressKey } from './qualifiedActionOperation';

const SERVER_ID = 'home-a';

function merge(store: ActionOperationStore, snapshots: readonly ActionOperationSnapshotV1[]): void {
    store.mergeSnapshots({ serverId: SERVER_ID, snapshots });
}

function operationAddress(operationId: string) {
    return { serverId: SERVER_ID, operationId } as const;
}

function sessionAddress(sessionId: string) {
    return { serverId: SERVER_ID, sessionId } as const;
}

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
    it('keeps identical operation, machine, session, and request IDs isolated by exact Home', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const shared = operation({
            operationId: 'shared-operation',
            requestId: 'shared-request',
            revision: 2,
            state: 'succeeded',
            settledAt: 120,
            scope: { accountId: 'account-a', machineId: 'shared-machine', sessionId: 'shared-session' },
        });

        store.mergeSnapshots({ serverId: 'home-a', snapshots: [shared] });
        store.mergeSnapshots({
            serverId: 'home-b',
            snapshots: [{ ...shared, title: 'Home B operation' }],
        });

        const state = store.getSnapshot();
        expect(state.operationsByKey.size).toBe(2);
        expect(selectors.selectById(state, { serverId: 'home-a', operationId: shared.operationId })?.serverId)
            .toBe('home-a');
        expect(selectors.selectById(state, { serverId: 'home-b', operationId: shared.operationId })?.snapshot.title)
            .toBe('Home B operation');
        expect(selectors.selectForSession(state, { serverId: 'home-a', sessionId: 'shared-session' })).toHaveLength(1);
        expect(selectors.selectForSession(state, { serverId: 'home-b', sessionId: 'shared-session' })).toHaveLength(1);
        expect(selectors.selectSnapshotByRequestId(state, 'shared-request', 'home-a', 'account-a')?.title)
            .toBe('Create session');
        expect(selectors.selectSnapshotByRequestId(state, 'shared-request', 'home-b', 'account-a')?.title)
            .toBe('Home B operation');

        store.setMachineObservation({ serverId: 'home-a', machineId: 'shared-machine' }, 'unavailable');
        expect(selectors.selectById(store.getSnapshot(), {
            serverId: 'home-a',
            operationId: shared.operationId,
        })?.observation).toBe('unavailable');
        expect(selectors.selectById(store.getSnapshot(), {
            serverId: 'home-b',
            operationId: shared.operationId,
        })?.observation).toBe('available');

        store.markFollowUpNeedsAttention({
            serverId: 'home-a',
            accountId: 'account-a',
            requestId: 'shared-request',
            message: 'Home A follow-up',
        });
        expect(selectors.selectById(store.getSnapshot(), { serverId: 'home-a', operationId: shared.operationId })?.followUpAttention)
            .toBe('Home A follow-up');
        expect(selectors.selectById(store.getSnapshot(), { serverId: 'home-b', operationId: shared.operationId })?.followUpAttention)
            .toBeNull();

        expect(store.markTerminalSeen({ serverId: 'home-a', operationId: shared.operationId }, 200)).toBe(true);
        expect(store.getSnapshot().seenAtByOperationKey.has(actionOperationAddressKey({
            serverId: 'home-a',
            operationId: shared.operationId,
        }))).toBe(true);
        expect(store.getSnapshot().seenAtByOperationKey.has(actionOperationAddressKey({
            serverId: 'home-b',
            operationId: shared.operationId,
        }))).toBe(false);
        expect(state.operationsByKey.has(actionOperationAddressKey({ serverId: 'home-a', operationId: shared.operationId })))
            .toBe(true);
    });

    it('rejects an unqualified legacy operation instead of exposing or relabeling it', () => {
        const store = createActionOperationStore();
        const shared = operation({ operationId: 'shared-operation' });

        store.mergeSnapshots({ serverId: null, snapshots: [shared] });
        store.mergeSnapshots({ serverId: 'home-a', snapshots: [{ ...shared, revision: 2, state: 'running', startedAt: 110 }] });

        const selectors = createActionOperationSelectors();
        expect(store.getSnapshot().operationsByKey.size).toBe(1);
        expect(selectors.selectById(
            store.getSnapshot(),
            { serverId: null, operationId: shared.operationId },
        )).toBeNull();
        expect(selectors.selectAll(store.getSnapshot()).map((operation) => operation.serverId))
            .toEqual(['home-a']);
    });

    it('rejects blank Home ingress instead of treating it as the legacy null Home', () => {
        const store = createActionOperationStore();

        store.mergeSnapshots({ serverId: '   ', snapshots: [operation()] });

        expect(store.getSnapshot().operationsByKey.size).toBe(0);
    });

    it('marks only the requested terminal operation seen', () => {
        const store = createActionOperationStore();
        const first = operation({ operationId: 'operation-1', revision: 3, state: 'succeeded', settledAt: 130, result: { sessionId: 'session-1' } });
        const second = operation({ operationId: 'operation-2', revision: 4, state: 'failed', settledAt: 140, error: { errorCode: 'failed', error: 'Failed' } });
        merge(store, [first, second]);

        expect(store.markTerminalSeen(operationAddress(first.operationId), 200)).toBe(true);
        expect(store.getSnapshot().seenAtByOperationKey.get(actionOperationAddressKey(operationAddress(first.operationId)))).toEqual({ seenAt: 200, revision: 3 });
        expect(store.getSnapshot().seenAtByOperationKey.has(actionOperationAddressKey(operationAddress(second.operationId)))).toBe(false);
        expect(store.markTerminalSeen(operationAddress(first.operationId), 300)).toBe(false);
    });

    it('keeps one row per operation ID across global and session selectors', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const accepted = operation();

        merge(store, [accepted, accepted]);

        const state = store.getSnapshot();
        expect(selectors.selectAll(state).map((row) => row.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(state, sessionAddress('session-a')).map((row) => row.snapshot.operationId)).toEqual(['operation-a']);
        expect(selectors.selectForSession(state, sessionAddress('session-b'))).toEqual([]);
    });

    it('keeps lifecycle monotonic and terminal snapshots immutable', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation()]);
        merge(store, [operation({ revision: 2, state: 'running', startedAt: 110 })]);
        merge(store, [operation({ revision: 3, state: 'succeeded', startedAt: 110, settledAt: 150, result: { sessionId: 'child' } })]);

        const terminal = selectors.selectAll(store.getSnapshot())[0]!.snapshot;

        merge(store, [operation({ revision: 4, state: 'running', startedAt: 110 })]);
        merge(store, [operation({ revision: 5, state: 'failed', startedAt: 110, settledAt: 160 })]);

        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot).toBe(terminal);
        expect(selectors.selectActive(store.getSnapshot())).toEqual([]);
    });

    it('projects unavailable observation without overwriting the canonical snapshot', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation({ revision: 2, state: 'running', startedAt: 110 })]);
        const canonical = selectors.selectAll(store.getSnapshot())[0]!.snapshot;

        store.setMachineObservation({ serverId: SERVER_ID, machineId: 'machine-a' }, 'unavailable');

        const projected = selectors.selectAll(store.getSnapshot())[0]!;
        expect(projected.observation).toBe('unavailable');
        expect(projected.snapshot).toBe(canonical);
        expect(projected.snapshot.state).toBe('running');
    });

    it('dismisses only an unavailable nonterminal projection while retaining daemon truth', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const canonical = operation({ revision: 2, state: 'running', startedAt: 110 });
        merge(store, [canonical]);

        expect(store.dismissUnavailable(operationAddress('operation-a'))).toBe(false);
        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationKeys: new Set([actionOperationAddressKey(operationAddress('operation-a'))]),
        });
        expect(store.dismissUnavailable(operationAddress('operation-a'))).toBe(true);

        expect(selectors.selectAll(store.getSnapshot())).toEqual([]);
        expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey(operationAddress('operation-a')))?.snapshot).toBe(canonical);
        expect(store.getSnapshot().unavailableOperationKeys.has(actionOperationAddressKey(operationAddress('operation-a')))).toBe(true);
        expect(store.dismissUnavailable(operationAddress('operation-a'))).toBe(false);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [canonical],
            knownOperationKeys: new Set([actionOperationAddressKey(operationAddress('operation-a'))]),
        });
        expect(selectors.selectAll(store.getSnapshot()).map((row) => row.snapshot.operationId))
            .toEqual(['operation-a']);
    });

    it('restores availability when a newer canonical snapshot arrives', () => {
        const store = createActionOperationStore();
        merge(store, [operation()]);
        store.setMachineObservation({ serverId: SERVER_ID, machineId: 'machine-a' }, 'unavailable');

        merge(store, [operation({ revision: 2, state: 'running', startedAt: 110 })]);

        expect(store.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey({ serverId: SERVER_ID, machineId: 'machine-a' }))).toBe('available');
    });

    it('keeps selector references stable while their structural inputs are unchanged', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation()]);
        const before = store.getSnapshot();
        const allBefore = selectors.selectAll(before);
        const sessionBefore = selectors.selectForSession(before, sessionAddress('session-a'));

        merge(store, [operation()]);

        const after = store.getSnapshot();
        expect(after).toBe(before);
        expect(selectors.selectAll(after)).toBe(allBefore);
        expect(selectors.selectForSession(after, sessionAddress('session-a'))).toBe(sessionBefore);
    });

    it('keeps unchanged row and scoped-list references stable across unrelated store updates', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation()]);
        const rowBefore = selectors.selectAll(store.getSnapshot())[0];
        const sessionBefore = selectors.selectForSession(store.getSnapshot(), sessionAddress('session-a'));

        merge(store, [operation({
            operationId: 'operation-b',
            scope: {
                accountId: 'account-a',
                machineId: 'machine-b',
                sessionId: 'session-b',
            },
        })]);

        const allAfterMerge = selectors.selectAll(store.getSnapshot());
        expect(allAfterMerge.find((row) => row.snapshot.operationId === 'operation-a')).toBe(rowBefore);
        expect(selectors.selectForSession(store.getSnapshot(), sessionAddress('session-a'))).toBe(sessionBefore);

        store.markAllTerminalSeen(200);
        expect(selectors.selectAll(store.getSnapshot())).toBe(allAfterMerge);
    });

    it('marks current terminal rows seen but treats later settlement as unseen', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation({ revision: 2, state: 'succeeded', settledAt: 150 })]);

        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(true);
        store.markAllTerminalSeen(200);
        expect(selectors.selectHasUnseenTerminal(store.getSnapshot())).toBe(false);

        merge(store, [
            operation({ operationId: 'operation-b', revision: 1, state: 'running', createdAt: 210 }),
        ]);
        store.markAllTerminalSeen(220);
        merge(store, [
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
        merge(store, [active, terminal]);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationKeys: new Set([active.operationId, terminal.operationId].map((operationId) => (
                actionOperationAddressKey(operationAddress(operationId))
            ))),
        });

        expect([...store.getSnapshot().operationsByKey.values()].map((operation) => operation.snapshot.operationId)).toEqual([active.operationId]);
        expect(store.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey({ serverId: SERVER_ID, machineId: 'machine-a' }))).toBe('available');
        expect(createActionOperationSelectors().selectById(store.getSnapshot(), operationAddress(active.operationId))?.observation)
            .toBe('unavailable');
    });

    it('marks only an omitted active row unavailable when another active row is listed on the same machine', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const listed = operation({ operationId: 'operation-listed', state: 'running', revision: 2, startedAt: 110 });
        const omitted = operation({ operationId: 'operation-omitted', state: 'running', revision: 2, startedAt: 110 });
        merge(store, [listed, omitted]);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [listed],
            knownOperationKeys: new Set([listed.operationId, omitted.operationId].map((operationId) => (
                actionOperationAddressKey(operationAddress(operationId))
            ))),
        });

        expect(selectors.selectById(store.getSnapshot(), operationAddress(listed.operationId))?.observation).toBe('available');
        expect(selectors.selectById(store.getSnapshot(), operationAddress(omitted.operationId))?.observation).toBe('unavailable');
        expect(store.dismissUnavailable(operationAddress(listed.operationId))).toBe(false);
        expect(store.dismissUnavailable(operationAddress(omitted.operationId))).toBe(true);
    });

    it('does not prune a concurrently accepted row that was not present when listing began', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const cached = operation({ operationId: 'operation-cached' });
        merge(store, [cached]);
        const knownOperationKeys = new Set(store.getSnapshot().operationsByKey.keys());
        const concurrent = operation({ operationId: 'operation-concurrent' });
        merge(store, [concurrent]);

        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [],
            knownOperationKeys,
        });

        expect([...store.getSnapshot().operationsByKey.values()].map((operation) => operation.snapshot.operationId)).toEqual([
            cached.operationId,
            concurrent.operationId,
        ]);
        expect(selectors.selectById(store.getSnapshot(), operationAddress(cached.operationId))?.observation).toBe('unavailable');
        expect(selectors.selectById(store.getSnapshot(), operationAddress(concurrent.operationId))?.observation).toBe('available');
    });

    it('removes operation rows when their machine leaves the active account projection', () => {
        const store = createActionOperationStore();
        merge(store, [
            operation({ operationId: 'removed-machine' }),
            operation({
                operationId: 'retained-machine',
                scope: { accountId: 'account-a', machineId: 'machine-b' },
            }),
        ]);

        store.retainAccountMachines({ serverId: SERVER_ID, accountId: 'account-a', machineIds: new Set(['machine-b']) });

        expect([...store.getSnapshot().operationsByKey.values()].map((operation) => operation.snapshot.operationId)).toEqual(['retained-machine']);
        expect(store.getSnapshot().machineObservationByKey.has(actionOperationMachineAddressKey({ serverId: SERVER_ID, machineId: 'machine-a' }))).toBe(false);
    });

    it('dismisses only successful recent rows while retaining active and attention rows', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [
            operation({ operationId: 'active' }),
            operation({ operationId: 'success', revision: 2, state: 'succeeded', startedAt: 110, settledAt: 150 }),
            operation({ operationId: 'failed', revision: 2, state: 'failed', startedAt: 110, settledAt: 150, error: { errorCode: 'failed', error: 'Failed' } }),
        ]);

        expect(store.dismissRecentSucceeded()).toBe(true);

        expect(selectors.selectAll(store.getSnapshot()).map((row) => row.snapshot.operationId))
            .toEqual(['active', 'failed']);
        expect(store.getSnapshot().operationsByKey.has(actionOperationAddressKey(operationAddress('success')))).toBe(true);
        expect(store.dismissRecentSucceeded()).toBe(false);
    });

    it('overlays UI follow-up attention on daemon success without changing its canonical lifecycle', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [operation({
            revision: 2,
            requestId: 'spawn-request',
            state: 'succeeded',
            startedAt: 110,
            settledAt: 150,
            result: { sessionId: 'created-session' },
        })]);

        store.markFollowUpNeedsAttention({
            serverId: SERVER_ID,
            accountId: 'account-a',
            requestId: 'spawn-request',
            message: 'Session created; setup needs attention',
        });

        const projected = selectors.selectAll(store.getSnapshot())[0]!;
        expect(projected.snapshot.state).toBe('succeeded');
        expect(projected.followUpAttention).toBe('Session created; setup needs attention');
        expect(selectors.selectHasAttention(store.getSnapshot())).toBe(true);
    });

    it('projects only response-required operations into Inbox and resolves them through existing lifecycle owners', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [
            operation({ operationId: 'routine-active', requestId: 'routine-request' }),
            operation({
                operationId: 'failed',
                revision: 2,
                state: 'failed',
                settledAt: 150,
                error: { errorCode: 'failed', error: 'Failed' },
            }),
            operation({
                operationId: 'setup',
                requestId: 'setup-request',
                revision: 2,
                state: 'succeeded',
                settledAt: 150,
                result: { sessionId: 'created-session' },
            }),
            operation({ operationId: 'cancelled', revision: 2, state: 'cancelled', settledAt: 150 }),
            operation({ operationId: 'unavailable', revision: 2, state: 'running', startedAt: 110 }),
        ]);
        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [
                operation({ operationId: 'routine-active' }),
                operation({
                    operationId: 'failed',
                    revision: 2,
                    state: 'failed',
                    settledAt: 150,
                    error: { errorCode: 'failed', error: 'Failed' },
                }),
                operation({
                    operationId: 'setup',
                    requestId: 'setup-request',
                    revision: 2,
                    state: 'succeeded',
                    settledAt: 150,
                    result: { sessionId: 'created-session' },
                }),
                operation({ operationId: 'cancelled', revision: 2, state: 'cancelled', settledAt: 150 }),
            ],
            knownOperationKeys: new Set(store.getSnapshot().operationsByKey.keys()),
        });

        expect(selectors.selectAll(store.getSnapshot()).map((entry) => entry.snapshot.operationId))
            .toEqual(expect.arrayContaining(['routine-active', 'failed', 'setup', 'cancelled', 'unavailable']));
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry, reason }) => [entry.snapshot.operationId, reason]))
            .toEqual(expect.arrayContaining([
                ['failed', 'failed'],
                ['unavailable', 'status_unavailable'],
            ]));
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry }) => entry.snapshot.operationId))
            .not.toEqual(expect.arrayContaining(['routine-active', 'setup', 'cancelled']));

        store.markFollowUpNeedsAttention({
            serverId: SERVER_ID,
            accountId: 'account-a',
            requestId: 'routine-request',
            message: 'An early follow-up must wait for terminal success',
        });
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry }) => entry.snapshot.operationId))
            .not.toContain('routine-active');

        expect(store.dismissRecentSucceeded()).toBe(true);
        store.markTerminalSeen(operationAddress('setup'), 175);
        const seenBeforeLateFollowUp = store.getSnapshot().seenAtByOperationKey;
        store.markFollowUpNeedsAttention({
            serverId: SERVER_ID,
            accountId: 'account-a',
            requestId: 'setup-request',
            message: 'Session created; setup needs attention',
        });
        expect(selectors.selectInbox(store.getSnapshot()).map(({ operation: entry, reason }) => [entry.snapshot.operationId, reason]))
            .toContainEqual(['setup', 'setup_needs_attention']);
        expect(store.getSnapshot().seenAtByOperationKey).toBe(seenBeforeLateFollowUp);

        expect(store.markTerminalSeen(operationAddress('failed'), 200)).toBe(true);
        expect(store.dismissUnavailable(operationAddress('unavailable'))).toBe(true);
        // Already-seen terminal acknowledgement still clears a later follow-up.
        expect(store.markTerminalSeen(operationAddress('setup'), 200)).toBe(true);
        expect(selectors.selectInbox(store.getSnapshot())).toEqual([]);
    });

    it('projects closed Activity and Inbox state without requiring detail row collections', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        merge(store, [
            operation({ operationId: 'available-active', state: 'running', startedAt: 110 }),
            operation({ operationId: 'unavailable-active', state: 'running', startedAt: 110 }),
            operation({
                operationId: 'failed',
                revision: 2,
                state: 'failed',
                settledAt: 150,
                error: { errorCode: 'failed', error: 'Failed' },
            }),
        ]);
        store.reconcileMachineProjection({
            serverId: SERVER_ID,
            accountId: 'account-a',
            machineId: 'machine-a',
            snapshots: [
                operation({ operationId: 'available-active', state: 'running', startedAt: 110 }),
                operation({
                    operationId: 'failed',
                    revision: 2,
                    state: 'failed',
                    settledAt: 150,
                    error: { errorCode: 'failed', error: 'Failed' },
                }),
            ],
            knownOperationKeys: new Set(store.getSnapshot().operationsByKey.keys()),
        });

        expect(selectors.selectActivitySummary(store.getSnapshot())).toEqual({
            activeCount: 1,
            hasAttention: true,
        });
        expect(selectors.selectInboxSummary(store.getSnapshot())).toEqual({
            count: 2,
            hasAttention: true,
        });

        store.markTerminalSeen(operationAddress('failed'), 200);
        store.dismissUnavailable(operationAddress('unavailable-active'));
        expect(selectors.selectInboxSummary(store.getSnapshot())).toEqual({
            count: 0,
            hasAttention: false,
        });
    });
    it('accepts a newer settled receipt refinement without reviving the lifecycle', () => {
        const store = createActionOperationStore();
        const selectors = createActionOperationSelectors();
        const cancelled = operation({ actionId: 'sessions.external.materialize.start', state: 'cancelled', startedAt: 100, settledAt: 150,
            revision: 4, progress: { kind: 'phase', phase: 'staging', label: 'Cancelled' } });
        merge(store, [cancelled]);
        merge(store, [{ ...cancelled, revision: 5, settledAt: 160, progress: { kind: 'phase', phase: 'staging', label: 'Discarded' } }]);
        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot.progress?.label).toBe('Discarded');
        merge(store, [{ ...cancelled, revision: 6, state: 'running', settledAt: undefined }]);
        expect(selectors.selectAll(store.getSnapshot())[0]!.snapshot.state).toBe('cancelled');
    });

});
