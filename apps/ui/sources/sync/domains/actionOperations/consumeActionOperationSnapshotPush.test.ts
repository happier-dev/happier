import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
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

        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([{ serverId: 'home-1', snapshot }]);
        expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['available']);
        expect(onSnapshot).toHaveBeenCalledWith({ serverId: 'home-1', snapshot });
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
