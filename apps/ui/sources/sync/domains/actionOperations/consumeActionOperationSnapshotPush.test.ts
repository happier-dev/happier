import { describe, expect, it, vi } from 'vitest';

import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { getActionOperation, type ActionOperationRpc } from '@/sync/ops/actionOperations';

import { createActionOperationStore } from './actionOperationStore';
import { consumeActionOperationSnapshotPush } from './consumeActionOperationSnapshotPush';

const snapshot: ActionOperationSnapshotV1 = {
    version: 1,
    operationId: 'operation-1',
    revision: 2,
    actionId: 'session.spawn_new',
    state: 'running',
    scope: { accountId: 'account-1', machineId: 'machine-1' },
    title: 'Create session',
    requestId: 'request-1',
    createdAt: 1,
    startedAt: 2,
    progress: { kind: 'phase', phase: 'creating', label: 'Creating session' },
    cancellation: 'supported',
};

// External Machine RPC only; use the real qualified current-reader response parser.
const rpc = (async () => ({ kind: 'found', operation: snapshot })) as ActionOperationRpc;
const readSnapshot = (operationId: string) => getActionOperation({
    machineId: 'machine-1', serverId: 'home-1', accountId: 'account-1',
    requireCurrentDomainFacts: true, operationId, rpc,
});

describe('consumeActionOperationSnapshotPush', () => {
    it.each(['plain', 'e2ee'] as const)('retains the admitted pre-dispatch reboot basis when the target disappears (%s)', async mode => {
        const store = createActionOperationStore();
        const reboot = ActionOperationSnapshotV1Schema.parse({ ...snapshot, actionId: 'machines.reboot',
            domainRef: { kind: 'machineReboot', serverId: 'home-1', machineId: 'machine-1', installationId: 'installation',
                task: { id: 'task', taskKind: 'machine.reboot.v1' }, basis: { bootedAt: 1000,
                    expectedRunningServiceIds: ['worker'], expectedRunningServicesKnown: true, dispatchStarted: true } } });
        // Only the Machine network transport disappears; parsing, admission scope,
        // revision checks and the actual surviving client store remain real.
        const unavailable = (async () => { throw new Error('Target disconnected'); }) as ActionOperationRpc;
        await consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: mode === 'plain'
                ? { t: 'plain', v: reboot } : { t: 'encrypted', c: 'sealed' } },
            accountEncryptionMode: mode, accountId: 'account-1', sourceServerId: 'home-1',
            openSnapshot: () => reboot, store,
            readSnapshot: operationId => getActionOperation({ machineId: 'machine-1', serverId: 'home-1',
                accountId: 'account-1', requireCurrentDomainFacts: true, operationId, rpc: unavailable }),
        });
        expect([...store.getSnapshot().operationsByKey.values()]).toEqual([{ serverId: 'home-1', snapshot: reboot, snapshotComplete: true }]);
        expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['unavailable']);
    });
    it('does not let abandoned read cleanup discard a replacement observer\'s pending revision', async () => {
        const store = createActionOperationStore();
        let oldCurrent = true;
        let reads = 0;
        const pending: Array<(response: Awaited<ReturnType<typeof readSnapshot>>) => void> = [];
        // Genuine Machine transport only; retain the qualified response parser.
        const rpc = (async () => { reads++; return await new Promise<Awaited<ReturnType<typeof readSnapshot>>>(resolve => pending.push(resolve)); }) as ActionOperationRpc;
        const consume = (shouldContinue: () => boolean) => consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: snapshot } },
            accountEncryptionMode: 'plain', accountId: 'account-1', sourceServerId: 'home-1', store, shouldContinue,
            readSnapshot: operationId => getActionOperation({ machineId: 'machine-1', serverId: 'home-1',
                accountId: 'account-1', requireCurrentDomainFacts: true, operationId, rpc }),
        });
        const abandoned = consume(() => oldCurrent);
        oldCurrent = false;
        const replacement = consume(() => true);
        pending[1]!({ kind: 'not_found' });
        await replacement;
        const current = consume(() => true);
        pending[0]!({ kind: 'found', operation: snapshot });
        await abandoned;
        const joined = consume(() => true);
        const beforeReplies = reads;
        pending[2]!({ kind: 'found', operation: snapshot });
        pending[3]?.({ kind: 'found', operation: snapshot });
        await Promise.all([current, joined]);
        expect(beforeReplies).toBe(3);
        expect([...store.getSnapshot().operationsByKey.values()]).toEqual([{ serverId: 'home-1', snapshot, snapshotComplete: true }]);
    });
    it('joins concurrent notifications of one new revision while a newer revision retains its own fresh read', async () => {
        const store = createActionOperationStore();
        const pending: Array<(response: Awaited<ReturnType<typeof readSnapshot>>) => void> = [];
        const read = vi.fn(() => new Promise<Awaited<ReturnType<typeof readSnapshot>>>(resolve => pending.push(resolve)));
        const consume = (pushed: ActionOperationSnapshotV1) => consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: pushed } },
            accountEncryptionMode: 'plain', accountId: 'account-1', sourceServerId: 'home-1', store, readSnapshot: read,
        });
        const requests = Array.from({ length: 20 }, () => consume(snapshot));
        expect(read).toHaveBeenCalledTimes(1);
        const newer: ActionOperationSnapshotV1 = { ...snapshot, revision: 3, state: 'succeeded', settledAt: 4, result: { sessionId: 'created' } };
        requests.push(consume(newer));
        expect(read).toHaveBeenCalledTimes(2);
        pending[1]!({ kind: 'found', operation: newer });
        pending[0]!({ kind: 'found', operation: snapshot });
        await Promise.all(requests);
        expect([...store.getSnapshot().operationsByKey.values()]).toEqual([{ serverId: 'home-1', snapshot: newer, snapshotComplete: true }]);
    });
    it('does not re-admit unchanged pushed revisions and admits one changed revision exactly once', async () => {
        const store = createActionOperationStore();
        store.mergeSnapshots({ serverId: 'home-1', snapshots: [snapshot], snapshotComplete: true });
        let current = snapshot;
        let reads = 0;
        // The external generic RPC transport returns this owner's parsed response.
        const rpc = (async () => { reads++; return { kind: 'found', operation: current }; }) as ActionOperationRpc;
        const onSnapshot = vi.fn();
        const consume = (pushed: ActionOperationSnapshotV1) => consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: pushed } },
            accountEncryptionMode: 'plain', accountId: 'account-1', sourceServerId: 'home-1', store, onSnapshot,
            readSnapshot: operationId => getActionOperation({ machineId: 'machine-1', serverId: 'home-1',
                accountId: 'account-1', requireCurrentDomainFacts: true, operationId, rpc }),
        });
        for (let i = 0; i < 100; i++) await consume({ ...snapshot });
        expect(reads).toBe(0);
        current = { ...snapshot, revision: 3, state: 'succeeded', settledAt: 4, result: { sessionId: 'created' } };
        await consume(current);
        expect(reads).toBe(1);
        expect([...store.getSnapshot().operationsByKey.values()]).toEqual([{ serverId: 'home-1', snapshot: current, snapshotComplete: true }]);
        expect(onSnapshot).toHaveBeenCalledWith({ serverId: 'home-1', snapshot: current, snapshotComplete: true });
    });
    it('does not present an older recovery result after a newer owner observation has arrived', async () => {
        const store = createActionOperationStore();
        const newer: ActionOperationSnapshotV1 = { ...snapshot, revision: 3, state: 'succeeded', settledAt: 4,
            result: { sessionId: 'created-session' } };
        let finish: ((response: Awaited<ReturnType<typeof readSnapshot>>) => void) | undefined;
        let started: (() => void) | undefined;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const onSnapshot = vi.fn();
        const consuming = consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: snapshot } },
            accountEncryptionMode: 'plain', accountId: 'account-1', sourceServerId: 'home-1', store, onSnapshot,
            readSnapshot: () => { started?.(); return new Promise(resolve => { finish = resolve; }); },
        });
        await reading;
        store.mergeSnapshots({ serverId: 'home-1', snapshots: [newer] });
        finish?.({ kind: 'found', operation: snapshot });
        await consuming;
        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([{ serverId: 'home-1', snapshot: newer }]);
        expect(onSnapshot).not.toHaveBeenCalled();
    });
    it('opens, validates, scope-fences, and merges one pushed revision', async () => {
        const store = createActionOperationStore();
        const onSnapshot = vi.fn();

        await consumeActionOperationSnapshotPush({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: 'sealed' },
            },
            accountEncryptionMode: 'e2ee',
            accountId: 'account-1',
            sourceServerId: 'home-1',
            openSnapshot: vi.fn(() => snapshot),
            readSnapshot,
            store,
            onSnapshot,
        });

        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([{ serverId: 'home-1', snapshot, snapshotComplete: true }]);
        expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['available']);
        expect(onSnapshot).toHaveBeenCalledWith({ serverId: 'home-1', snapshot, snapshotComplete: true });
    });

    it.each([
        ['invalid payload', { nope: true }],
        ['wrong Account', { ...snapshot, scope: { ...snapshot.scope, accountId: 'account-2' } }],
        ['wrong machine', { ...snapshot, scope: { ...snapshot.scope, machineId: 'machine-2' } }],
    ])('drops %s without changing shared state', async (_name, opened) => {
        const store = createActionOperationStore();
        const onSnapshot = vi.fn();

        await consumeActionOperationSnapshotPush({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: 'sealed' },
            },
            accountEncryptionMode: 'e2ee',
            accountId: 'account-1',
            sourceServerId: 'home-1',
            openSnapshot: () => opened,
            readSnapshot,
            store,
            onSnapshot,
        });

        expect(store.getSnapshot().operationsByKey.size).toBe(0);
        expect(onSnapshot).not.toHaveBeenCalled();
    });

    it('drops a pushed snapshot when its transport Home is missing or blank', async () => {
        const store = createActionOperationStore();

        await consumeActionOperationSnapshotPush({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'encrypted', c: 'sealed' } },
            accountEncryptionMode: 'e2ee',
            accountId: 'account-1',
            sourceServerId: '   ',
            openSnapshot: () => snapshot,
            readSnapshot,
            store,
        });

        expect(store.getSnapshot().operationsByKey.size).toBe(0);
    });
});
