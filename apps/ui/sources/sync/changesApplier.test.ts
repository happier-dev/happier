import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { applyPlannedChangeActions } from './changesApplier';
import type { PlannedChangeActions } from './changesPlanner';

const credentials: AuthCredentials = { token: 't', secret: 's' };

function buildPlanned(partial: {
    sessionIdsToCatchUp?: string[];
    invalidate?: Partial<PlannedChangeActions['invalidate']>;
    kv?: PlannedChangeActions['kv'];
}): PlannedChangeActions {
    return {
        sessionIdsToCatchUp: partial.sessionIdsToCatchUp ?? [],
        invalidate: {
            sessions: false,
            machines: false,
            artifacts: false,
            settings: false,
            profile: false,
            friends: false,
            feed: false,
            ...(partial.invalidate ?? {}),
        },
        kv: partial.kv ?? { type: 'none' },
    };
}

describe('changesApplier', () => {
    it('invalidates friend requests when friends invalidation is planned', async () => {
        const invalidateFriends = vi.fn(async () => {});
        const invalidateFriendRequests = vi.fn(async () => {});

        await applyPlannedChangeActions({
            planned: buildPlanned({ invalidate: { friends: true } }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                friends: invalidateFriends,
                friendRequests: invalidateFriendRequests,
            },
            invalidateMessagesForSession: async () => {},
            invalidateGitStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidateFriends).toHaveBeenCalledTimes(1);
        expect(invalidateFriendRequests).toHaveBeenCalledTimes(1);
    });

    it('only catches up messages for sessions that are already loaded', async () => {
        const invalidateMessagesForSession = vi.fn(async () => {});
        const invalidateGitStatusForSession = vi.fn(() => {});

        await applyPlannedChangeActions({
            planned: buildPlanned({ sessionIdsToCatchUp: ['s1', 's2'] }),
            credentials,
            isSessionMessagesLoaded: (sessionId) => sessionId === 's1',
            invalidate: {},
            invalidateMessagesForSession,
            invalidateGitStatusForSession,
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidateMessagesForSession).toHaveBeenCalledTimes(1);
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
        expect(invalidateGitStatusForSession).toHaveBeenCalledTimes(1);
        expect(invalidateGitStatusForSession).toHaveBeenCalledWith('s1');
    });

    it('applies todo KV updates when all requested keys are present', async () => {
        const applyTodoSocketUpdates = vi.fn(async () => {});
        const invalidateTodos = vi.fn(async () => {});
        const kvBulkGet = vi.fn(async (_credentials: AuthCredentials, keys: string[]) => ({
            values: keys.map((key) => ({ key, value: 'v', version: 1 })),
        }));

        await applyPlannedChangeActions({
            planned: buildPlanned({
                kv: { type: 'bulk-keys', feature: 'todos', keys: ['todo.a', 'other.b', 'todo.c'] },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                todos: invalidateTodos,
            },
            invalidateMessagesForSession: async () => {},
            invalidateGitStatusForSession: () => {},
            applyTodoSocketUpdates,
            kvBulkGet,
        });

        expect(kvBulkGet).toHaveBeenCalledTimes(1);
        expect(kvBulkGet).toHaveBeenCalledWith(credentials, ['todo.a', 'todo.c']);
        expect(applyTodoSocketUpdates).toHaveBeenCalledTimes(1);
        expect(applyTodoSocketUpdates).toHaveBeenCalledWith([
            { key: 'todo.a', value: 'v', version: 1 },
            { key: 'todo.c', value: 'v', version: 1 },
        ]);
        expect(invalidateTodos).not.toHaveBeenCalled();
    });

    it('falls back to todos invalidation when bulk KV results are incomplete', async () => {
        const applyTodoSocketUpdates = vi.fn(async () => {});
        const invalidateTodos = vi.fn(async () => {});
        const kvBulkGet = vi.fn(async (_credentials: AuthCredentials, keys: string[]) => ({
            values: keys.slice(0, 1).map((key) => ({ key, value: 'v', version: 1 })),
        }));

        await applyPlannedChangeActions({
            planned: buildPlanned({
                kv: { type: 'bulk-keys', feature: 'todos', keys: ['todo.a', 'todo.c'] },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                todos: invalidateTodos,
            },
            invalidateMessagesForSession: async () => {},
            invalidateGitStatusForSession: () => {},
            applyTodoSocketUpdates,
            kvBulkGet,
        });

        expect(applyTodoSocketUpdates).not.toHaveBeenCalled();
        expect(invalidateTodos).toHaveBeenCalledTimes(1);
    });
});
