import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { applyPlannedChangeActions } from './changesApplier';
import type { PlannedChangeActions } from './changesPlanner';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';

const credentials: AuthCredentials = { token: 't', secret: 's' };

function buildPlanned(partial: {
    changes?: ApiChangeEntry[];
    sessionIdsToCatchUp?: string[];
    unsupportedChanges?: PlannedChangeActions['unsupportedChanges'];
    invalidate?: Partial<PlannedChangeActions['invalidate']>;
    kv?: PlannedChangeActions['kv'];
}): PlannedChangeActions {
    return {
        changes: partial.changes ?? [],
        sessionIdsToCatchUp: partial.sessionIdsToCatchUp ?? [],
        unsupportedChanges: partial.unsupportedChanges ?? [],
        invalidate: {
            sessions: false,
            machines: false,
            artifacts: false,
            settings: false,
            profile: false,
            friends: false,
            feed: false,
            automations: false,
            pets: false,
            ...(partial.invalidate ?? {}),
        },
        kv: partial.kv ?? { type: 'none' },
    };
}

function buildChange(params: {
    cursor: number;
    kind: ApiChangeEntry['kind'];
    entityId?: string;
    hint?: ApiChangeEntry['hint'];
}): ApiChangeEntry {
    return {
        cursor: params.cursor,
        kind: params.kind,
        entityId: params.entityId ?? 'self',
        changedAt: params.cursor,
        hint: params.hint ?? null,
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

    it('invalidates account pets when pet invalidation is planned', async () => {
        const invalidatePets = vi.fn(async () => {});

        await applyPlannedChangeActions({
            planned: buildPlanned({ invalidate: { pets: true } }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                pets: invalidatePets,
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidatePets).toHaveBeenCalledTimes(1);
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

    it('respects concurrencyLimit when applying planned invalidations', async () => {
        let resolveFirst: () => void = () => {};
        const firstStarted: { value: boolean } = { value: false };
        const secondStarted: { value: boolean } = { value: false };

        const invalidateSettings = vi.fn(async () => {
            firstStarted.value = true;
            await new Promise<void>((resolve) => {
                resolveFirst = () => resolve();
            });
        });

        const invalidateProfile = vi.fn(async () => {
            secondStarted.value = true;
        });

        const p = applyPlannedChangeActions({
            planned: buildPlanned({ invalidate: { settings: true, profile: true } }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                settings: invalidateSettings,
                profile: invalidateProfile,
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
            concurrencyLimit: 1,
        });

        await vi.waitFor(() => {
            expect(firstStarted.value).toBe(true);
        });

        expect(secondStarted.value).toBe(false);

        resolveFirst();
        await p;

        expect(invalidateSettings).toHaveBeenCalledTimes(1);
        expect(invalidateProfile).toHaveBeenCalledTimes(1);
    });

    it('waits for sessions invalidation before catching up session messages', async () => {
        let resolveSessions: () => void = () => {};
        let sessionsInvalidated = false;

        const invalidateSessions = vi.fn(async () => {
            await new Promise<void>((resolve) => {
                resolveSessions = resolve;
            });
            sessionsInvalidated = true;
        });

        const invalidateMessagesForSession = vi.fn(async () => {
            expect(sessionsInvalidated).toBe(true);
        });

        const p = applyPlannedChangeActions({
            planned: buildPlanned({ sessionIdsToCatchUp: ['s1'], invalidate: { sessions: true } }),
            credentials,
            isSessionMessagesLoaded: () => true,
            invalidate: {
                sessions: invalidateSessions,
            },
            invalidateMessagesForSession,
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
            concurrencyLimit: 2,
        });

        await vi.waitFor(() => {
            expect(invalidateSessions).toHaveBeenCalledTimes(1);
        });
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();

        resolveSessions();
        await p;

        expect(invalidateMessagesForSession).toHaveBeenCalledTimes(1);
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1');
    });

    it('returns partial materialization when sessions invalidation fails during loaded session catch-up', async () => {
        const invalidateSessions = vi.fn(async () => {
            throw new Error('Required session hydration failed for s1');
        });
        const invalidateMessagesForSession = vi.fn(async () => {});

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
                ],
                sessionIdsToCatchUp: ['s1'],
                invalidate: { sessions: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            invalidate: {
                sessions: invalidateSessions,
            },
            invalidateMessagesForSession,
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: null,
            blockedCursor: '1',
            blockedReason: 'partial-materialization',
        });
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
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

    it('does not advance through an unsupported change cursor so later resumes can recover it', async () => {
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 'unloaded' }),
                    buildChange({ cursor: 2, kind: 'new-kind' as ApiChangeEntry['kind'], entityId: 'x' }),
                    buildChange({ cursor: 3, kind: 'session', entityId: 'also-unloaded' }),
                ],
                unsupportedChanges: [{ cursor: '2', kind: 'new-kind', entityId: 'x' }],
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: '1',
            blockedCursor: '2',
            blockedReason: 'unsupported-kind',
        });
    });

    it('leaves the safe cursor behind an unsupported head change', async () => {
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'new-kind' as ApiChangeEntry['kind'], entityId: 'x' }),
                    buildChange({ cursor: 2, kind: 'session', entityId: 'later-session' }),
                ],
                unsupportedChanges: [{ cursor: '1', kind: 'new-kind', entityId: 'x' }],
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: null,
            blockedCursor: '1',
            blockedReason: 'unsupported-kind',
        });
    });

    it('advances only through loaded session catch-ups that completed in feed order', async () => {
        const invalidateMessagesForSession = vi.fn(async (sessionId: string) => {
            if (sessionId === 's2') throw new Error('cancelled');
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
                    buildChange({ cursor: 2, kind: 'session', entityId: 's2' }),
                    buildChange({ cursor: 3, kind: 'session', entityId: 's3' }),
                ],
                sessionIdsToCatchUp: ['s1', 's2', 's3'],
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            invalidate: {},
            invalidateMessagesForSession,
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: '1',
            blockedCursor: '2',
            blockedReason: 'partial-materialization',
        });
    });

    it('blocks loaded session advancement until the materialized seq reaches the server hint', async () => {
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 's1', hint: { lastMessageSeq: 120 } }),
                ],
                sessionIdsToCatchUp: ['s1'],
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 119,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: null,
            blockedCursor: '1',
            blockedReason: 'partial-materialization',
        });
    });

    it('advances loaded session rows when the materialized seq reaches the server hint', async () => {
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 's1', hint: { lastMessageSeq: 120 } }),
                ],
                sessionIdsToCatchUp: ['s1'],
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 120,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toEqual({
            status: 'complete',
            safeAdvanceCursor: '1',
            processedChanges: 1,
            blockedChanges: 0,
        });
    });

    it('blocks a pending-hint change when pending convergence fails', async () => {
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({
                        cursor: 1,
                        kind: 'session',
                        entityId: 's1',
                        hint: { pendingVersion: 10, pendingCount: 1 },
                    }),
                ],
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
            convergePendingForSession: async () => {
                throw new Error('auth failed');
            },
        });

        expect(result).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: null,
            blockedCursor: '1',
            blockedReason: 'pending-not-converged',
        });
    });
});
