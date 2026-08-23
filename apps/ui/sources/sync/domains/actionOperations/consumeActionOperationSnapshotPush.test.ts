import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

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

describe('consumeActionOperationSnapshotPush', () => {
    it('opens, validates, scope-fences, and merges one pushed revision', async () => {
        const store = createActionOperationStore();
        const onSnapshot = vi.fn();

        await consumeActionOperationSnapshotPush({
            update: {
                type: 'action-operation-snapshot',
                machineId: 'machine-1',
                ciphertext: 'sealed',
            },
            accountId: 'account-1',
            openSnapshot: vi.fn(() => snapshot),
            store,
            onSnapshot,
        });

        expect(store.getSnapshot().operationsById.get(snapshot.operationId)).toStrictEqual(snapshot);
        expect(store.getSnapshot().machineObservationById.get('machine-1')).toBe('available');
        expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ operationId: snapshot.operationId }));
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
                type: 'action-operation-snapshot',
                machineId: 'machine-1',
                ciphertext: 'sealed',
            },
            accountId: 'account-1',
            openSnapshot: () => opened,
            store,
            onSnapshot,
        });

        expect(store.getSnapshot().operationsById.size).toBe(0);
        expect(onSnapshot).not.toHaveBeenCalled();
    });
});
