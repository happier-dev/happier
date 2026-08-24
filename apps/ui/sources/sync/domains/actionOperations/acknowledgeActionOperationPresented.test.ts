import { describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationStore } from './actionOperationStore';
import { acknowledgeActionOperationPresented } from './acknowledgeActionOperationPresented';

function operation(state: ActionOperationSnapshotV1['state']): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: state === 'running' ? 1 : 2,
        actionId: 'plugin.example/process',
        state,
        scope: { accountId: 'account-1', machineId: 'machine-1' },
        title: 'Process item',
        createdAt: 1,
        ...(state === 'running' ? { startedAt: 2 } : { settledAt: 3 }),
        cancellation: 'unsupported',
    };
}

describe('acknowledgeActionOperationPresented', () => {
    it('acknowledges any exact terminal operation without depending on its action kind', () => {
        const store = createActionOperationStore();
        const succeeded = operation('succeeded');
        store.merge(succeeded);

        expect(acknowledgeActionOperationPresented(succeeded, store)).toBe(true);
        expect(store.getState().terminalSeenAtById.has(succeeded.operationId)).toBe(true);
    });

    it('does not acknowledge an operation before its outcome is visible', () => {
        const store = createActionOperationStore();
        const markSeen = vi.spyOn(store, 'markSeen');

        expect(acknowledgeActionOperationPresented(operation('running'), store)).toBe(false);
        expect(markSeen).not.toHaveBeenCalled();
    });
});
