import { describe, expect, it } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationStore } from './actionOperationStore';
import {
    createActionOperationObservationsSelector,
    createAllActionOperationsSelector,
} from './useActionOperations';

function snapshot(operationId: string, accountId: string, machineId: string): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId,
        revision: 1,
        actionId: 'session.spawn_new',
        state: 'accepted',
        scope: { accountId, machineId },
        title: 'Create session',
        createdAt: 1_000,
        cancellation: 'unsupported',
    };
}

describe('global action operation selectors', () => {
    it('returns all machines for one account with stable operation and observation references', () => {
        const store = createActionOperationStore();
        const selectAll = createAllActionOperationsSelector('account-1');
        const selectObservations = createActionOperationObservationsSelector('account-1');
        const first = snapshot('operation-1', 'account-1', 'machine-1');
        const second = snapshot('operation-2', 'account-1', 'machine-2');
        store.merge(first);
        store.merge(second);

        const operationsBefore = selectAll(store.getState());
        const observationsBefore = selectObservations(store.getState());
        expect(operationsBefore).toEqual([first, second]);

        store.merge(snapshot('other-account', 'account-2', 'machine-3'));
        expect(selectAll(store.getState())).toBe(operationsBefore);
        expect(selectObservations(store.getState())).toBe(observationsBefore);

        store.setObservation({ accountId: 'account-1', machineId: 'machine-2' }, 'reconnecting');
        expect(selectAll(store.getState())).toBe(operationsBefore);
        expect(selectObservations(store.getState()).get('machine-2')).toBe('reconnecting');
    });
});
