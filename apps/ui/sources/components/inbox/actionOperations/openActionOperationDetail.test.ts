import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

import { refreshActionOperationDetail } from './openActionOperationDetail';

const lightweight: ActionOperationSnapshotV1 = {
    version: 1,
    operationId: 'operation-1',
    revision: 3,
    actionId: 'session.spawn_new',
    state: 'succeeded',
    scope: { accountId: 'account-1', machineId: 'machine-1' },
    title: 'Create session',
    createdAt: 1_000,
    settledAt: 2_000,
    cancellation: 'unsupported',
};

describe('action operation detail reopen', () => {
    it('gets and merges the full snapshot every time detail opens', async () => {
        const store = createActionOperationStore();
        const full = { ...lightweight, result: { type: 'success', sessionId: 'session-created' } };
        const get = vi.fn(async () => ({ kind: 'found' as const, operation: full }));
        store.merge(lightweight);

        await refreshActionOperationDetail({ operationId: lightweight.operationId, store, get });
        await refreshActionOperationDetail({ operationId: lightweight.operationId, store, get });

        expect(get).toHaveBeenCalledTimes(2);
        expect(get).toHaveBeenCalledWith({ machineId: 'machine-1', operationId: 'operation-1' });
        expect(store.getState().operationsById.get(lightweight.operationId)).toBe(full);
    });

    it('projects status unavailable without erasing the last snapshot when get reports not_found', async () => {
        const store = createActionOperationStore();
        store.merge(lightweight);

        await refreshActionOperationDetail({
            operationId: lightweight.operationId,
            store,
            get: async () => ({ kind: 'not_found' }),
        });

        expect(store.getState().operationsById.get(lightweight.operationId)).toBe(lightweight);
        expect(Array.from(store.getState().observationByScope.values())).toEqual(['status_unavailable']);
    });
});
