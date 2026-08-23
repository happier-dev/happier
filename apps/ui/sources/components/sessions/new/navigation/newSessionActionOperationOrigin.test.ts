import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

const loadNewSessionDraftMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const actionOperationStoreSnapshot = vi.hoisted(() => ({
    followUpAttentionByRequestId: new Map<string, string>(),
}));

vi.mock('expo-router', () => ({
    router: { push: routerPushMock },
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    loadNewSessionDraft: loadNewSessionDraftMock,
}));

vi.mock('@/sync/domains/actionOperations/actionOperationStore', () => ({
    actionOperationStore: {
        getSnapshot: () => actionOperationStoreSnapshot,
    },
}));

import { createNewSessionActionOperationOrigin } from './newSessionActionOperationOrigin';

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'session.spawn_new',
        state: 'running',
        scope: { accountId: 'account-a', machineId: 'machine-a' },
        title: 'Create session',
        requestId: 'request-1',
        createdAt: 1,
        startedAt: 2,
        progress: { kind: 'phase', phase: 'spawning', label: 'Spawning' },
        cancellation: 'supported',
        ...overrides,
    };
}

beforeEach(() => {
    loadNewSessionDraftMock.mockReset();
    loadNewSessionDraftMock.mockReturnValue({ input: 'persisted prompt' });
    routerPushMock.mockReset();
    actionOperationStoreSnapshot.followUpAttentionByRequestId.clear();
});

describe('createNewSessionActionOperationOrigin', () => {
    it.each(['failed', 'cancelled'] as const)(
        'reopens a %s operation from the exact persisted draft scope after the launching surface is gone',
        (state) => {
            const mutableScope = { serverId: 'server-a', accountId: 'account-a' };
            const origin = createNewSessionActionOperationOrigin(mutableScope);
            mutableScope.serverId = 'mutated-after-registration';

            const reopen = origin.resolve(operation({ state, settledAt: 3 }));
            reopen?.();

            expect(loadNewSessionDraftMock).toHaveBeenCalledWith({
                serverId: 'server-a',
                accountId: 'account-a',
            });
            expect(routerPushMock).toHaveBeenCalledWith('/new');
        },
    );

    it('reopens daemon success whose client-side setup still needs attention', () => {
        actionOperationStoreSnapshot.followUpAttentionByRequestId.set('request-1', 'Setup needs attention');
        const origin = createNewSessionActionOperationOrigin({ serverId: 'server-a', accountId: 'account-a' });

        const reopen = origin.resolve(operation({
            state: 'succeeded',
            settledAt: 3,
            result: { sessionId: 'session-created' },
        }));
        reopen?.();

        expect(routerPushMock).toHaveBeenCalledWith('/new');
    });

    it('leaves active progress, complete success, and missing drafts to standard Activity presentation', () => {
        const origin = createNewSessionActionOperationOrigin({ serverId: 'server-a', accountId: 'account-a' });

        expect(origin.resolve(operation())).toBeNull();
        expect(origin.resolve(operation({
            state: 'succeeded',
            settledAt: 3,
            result: { sessionId: 'session-created' },
        }))).toBeNull();

        loadNewSessionDraftMock.mockReturnValue(null);
        expect(origin.resolve(operation({ state: 'failed', settledAt: 3 }))).toBeNull();
        expect(routerPushMock).not.toHaveBeenCalled();
    });
});
