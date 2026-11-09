import { describe, expect, it, vi } from 'vitest';
import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { handleUpdateContainer } from './socket';
import { subscribeKvPrefixChanges, type KvSocketChange } from './kvUpdateDispatcher';

function params(updateData: ApiUpdateContainer, shouldContinue = () => true): Parameters<typeof handleUpdateContainer>[0] {
    return {
        updateData, encryption: null, credentials: { token: 'Account-A' }, shouldContinue,
        artifactDataKeys: new Map(), applySessions: vi.fn(), fetchSessions: vi.fn(),
        applyMessages: vi.fn(), onSessionVisible: vi.fn(), isSessionMessagesLoaded: () => false,
        getSessionMaterializedMaxSeq: () => 0, markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(), assumeUsers: async () => {}, applyTodoSocketUpdates: async () => {},
        invalidateMachines: vi.fn(), invalidateSessions: vi.fn(), invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(), invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(), invalidateTodos: vi.fn(), log: { log: vi.fn() },
    };
}

describe('socket KV prefix dispatch', () => {
    it('delivers workspace changes and preserves todo routing without unrelated keys', async () => {
        const workspace: KvSocketChange[] = [];
        const todos: KvSocketChange[] = [];
        const dispose = subscribeKvPrefixChanges('workspace:', changes => workspace.push(...changes), {
            credentials: { token: 'Account-A' }, shouldContinue: () => true,
        });
        const changes = [
            { key: 'todo.index', value: 'todo-record', version: 3 },
            { key: 'workspace:tabs:v1', value: 'workspace-record', version: 8 },
            { key: 'plugin:other', value: 'unrelated', version: 1 },
        ];
        try {
            await handleUpdateContainer({
                ...params({ id: 'update', seq: 1, createdAt: 1, body: { t: 'kv-batch-update', changes } }),
                applyTodoSocketUpdates: async values => { todos.push(...values); },
            });
            expect(workspace).toEqual([changes[1]]);
            expect(todos).toEqual([changes[0]]);
        } finally { dispose(); }
    });

    it('does not deliver old Account events, retired subscriptions, or disposed subscriptions', async () => {
        const received: KvSocketChange[] = [];
        const changes = [{ key: 'workspace:tabs:v1', value: null, version: 9 }];
        const update: ApiUpdateContainer = { id: 'update', seq: 1, createdAt: 1, body: { t: 'kv-batch-update', changes } };
        let mounted = true;
        const dispose = subscribeKvPrefixChanges('workspace:', values => received.push(...values), {
            credentials: { token: 'Account-B' }, shouldContinue: () => mounted,
        });
        try {
            await handleUpdateContainer(params(update));
            expect(received).toEqual([]);
            mounted = false;
            await handleUpdateContainer({ ...params(update), credentials: { token: 'Account-B' } });
            expect(received).toEqual([]);
            mounted = true;
            await handleUpdateContainer({ ...params(update, () => false), credentials: { token: 'Account-B' } });
            expect(received).toEqual([]);
            await handleUpdateContainer({ ...params(update), credentials: { token: 'Account-B' } });
            expect(received).toEqual(changes);
            dispose();
            await handleUpdateContainer({ ...params(update), credentials: { token: 'Account-B' } });
            expect(received).toEqual(changes);
        } finally { dispose(); }
    });
});
