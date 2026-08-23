import { describe, expect, it } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationStore } from './actionOperationStore';
import { observeActionOperationTerminal } from './observeActionOperationTerminal';

function snapshot(state: ActionOperationSnapshotV1['state']): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'handoff-operation',
        requestId: 'request-1',
        revision: state === 'running' ? 1 : 2,
        actionId: 'session.handoff',
        state,
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Hand off session',
        createdAt: 1,
        startedAt: 2,
        ...(state === 'succeeded' ? { settledAt: 3, result: { handoffId: 'handoff-1' } } : {}),
        cancellation: 'supported',
    };
}

describe('observeActionOperationTerminal', () => {
    it('resolves an already-observed matching terminal snapshot', async () => {
        const store = createActionOperationStore();
        const terminal = snapshot('succeeded');
        store.merge(terminal);

        await expect(observeActionOperationTerminal({
            store,
            accountId: 'account-1',
            machineId: 'machine-1',
            actionId: 'session.handoff',
            requestId: 'request-1',
        })).resolves.toBe(terminal);
    });

    it('subscribes until the matching pushed operation terminalizes', async () => {
        const store = createActionOperationStore();
        store.merge(snapshot('running'));
        const observed = observeActionOperationTerminal({
            store,
            accountId: 'account-1',
            machineId: 'machine-1',
            actionId: 'session.handoff',
            requestId: 'request-1',
        });

        const terminal = snapshot('succeeded');
        store.merge(terminal);
        await expect(observed).resolves.toBe(terminal);
    });

    it('rejects cancellation with AbortError', async () => {
        const store = createActionOperationStore();
        const controller = new AbortController();
        const observed = observeActionOperationTerminal({
            store,
            accountId: 'account-1',
            machineId: 'machine-1',
            actionId: 'session.handoff',
            requestId: 'request-1',
            signal: controller.signal,
        });

        controller.abort();
        await expect(observed).rejects.toMatchObject({ name: 'AbortError' });
    });
});
