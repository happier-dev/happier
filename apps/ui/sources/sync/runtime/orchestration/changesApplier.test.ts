import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
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
            automations: false,
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
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidateFriends).toHaveBeenCalledTimes(1);
        expect(invalidateFriendRequests).toHaveBeenCalledTimes(1);
    });

    it('only catches up messages for sessions that are already loaded', async () => {
        const invalidateMessagesForSession = vi.fn(async () => {});
        const invalidateScmStatusForSession = vi.fn(() => {});

        await applyPlannedChangeActions({
            planned: buildPlanned({ sessionIdsToCatchUp: ['s1', 's2'] }),
            credentials,
            isSessionMessagesLoaded: (sessionId) => sessionId === 's1',
            invalidate: {},
            invalidateMessagesForSession,
            invalidateScmStatusForSession,
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidateMessagesForSession).toHaveBeenCalledTimes(1);
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
        expect(invalidateScmStatusForSession).toHaveBeenCalledTimes(1);
        expect(invalidateScmStatusForSession).toHaveBeenCalledWith('s1');
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
            invalidateScmStatusForSession: () => {},
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
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates,
            kvBulkGet,
        });

        expect(applyTodoSocketUpdates).not.toHaveBeenCalled();
        expect(invalidateTodos).toHaveBeenCalledTimes(1);
    });

    it('runs all planned invalidations and catches up only loaded sessions', async () => {
        const invalidateSettings = vi.fn(async () => {});
        const invalidateProfile = vi.fn(async () => {});
        const invalidateMachines = vi.fn(async () => {});
        const invalidateArtifacts = vi.fn(async () => {});
        const invalidateFeed = vi.fn(async () => {});
        const invalidateAutomations = vi.fn(async () => {});
        const invalidateSessions = vi.fn(async () => {});
        const invalidateMessagesForSession = vi.fn(async () => {});
        const invalidateScmStatusForSession = vi.fn(() => {});

        await applyPlannedChangeActions({
            planned: buildPlanned({
                sessionIdsToCatchUp: ['s1', 's2'],
                invalidate: {
                    settings: true,
                    profile: true,
                    machines: true,
                    artifacts: true,
                    feed: true,
                    automations: true,
                    sessions: true,
                },
            }),
            credentials,
            isSessionMessagesLoaded: (sessionId) => sessionId === 's2',
            invalidate: {
                settings: invalidateSettings,
                profile: invalidateProfile,
                machines: invalidateMachines,
                artifacts: invalidateArtifacts,
                feed: invalidateFeed,
                automations: invalidateAutomations,
                sessions: invalidateSessions,
            },
            invalidateMessagesForSession,
            invalidateScmStatusForSession,
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidateSettings).toHaveBeenCalledTimes(1);
        expect(invalidateProfile).toHaveBeenCalledTimes(1);
        expect(invalidateMachines).toHaveBeenCalledTimes(1);
        expect(invalidateArtifacts).toHaveBeenCalledTimes(1);
        expect(invalidateFeed).toHaveBeenCalledTimes(1);
        expect(invalidateAutomations).toHaveBeenCalledTimes(1);
        expect(invalidateSessions).toHaveBeenCalledTimes(1);
        expect(invalidateMessagesForSession).toHaveBeenCalledTimes(1);
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s2');
        expect(invalidateScmStatusForSession).toHaveBeenCalledTimes(1);
        expect(invalidateScmStatusForSession).toHaveBeenCalledWith('s2');
    });

    it('invalidates todos for refresh-feature KV plan', async () => {
        const invalidateTodos = vi.fn(async () => {});
        const kvBulkGet = vi.fn(async () => ({ values: [] as Array<{ key: string; value: string | null; version: number }> }));

        await applyPlannedChangeActions({
            planned: buildPlanned({
                kv: { type: 'refresh-feature', feature: 'todos' },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { todos: invalidateTodos },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet,
        });

        expect(invalidateTodos).toHaveBeenCalledTimes(1);
        expect(kvBulkGet).not.toHaveBeenCalled();
    });

    it('skips KV calls when bulk-keys plan has no todo-prefixed keys', async () => {
        const invalidateTodos = vi.fn(async () => {});
        const kvBulkGet = vi.fn(async () => ({ values: [] as Array<{ key: string; value: string | null; version: number }> }));

        await applyPlannedChangeActions({
            planned: buildPlanned({
                kv: { type: 'bulk-keys', feature: 'todos', keys: ['settings.a', 'profile.b'] },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { todos: invalidateTodos },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet,
        });

        expect(kvBulkGet).not.toHaveBeenCalled();
        expect(invalidateTodos).not.toHaveBeenCalled();
    });

    it('falls back to todos invalidation when bulk KV request throws', async () => {
        const applyTodoSocketUpdates = vi.fn(async () => {});
        const invalidateTodos = vi.fn(async () => {});
        const kvBulkGet = vi.fn(async () => {
            throw new Error('network down');
        });

        await applyPlannedChangeActions({
            planned: buildPlanned({
                kv: { type: 'bulk-keys', feature: 'todos', keys: ['todo.a'] },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { todos: invalidateTodos },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates,
            kvBulkGet,
        });

        expect(kvBulkGet).toHaveBeenCalledTimes(1);
        expect(applyTodoSocketUpdates).not.toHaveBeenCalled();
        expect(invalidateTodos).toHaveBeenCalledTimes(1);
    });
});
