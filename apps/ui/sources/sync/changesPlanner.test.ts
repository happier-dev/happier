import { describe, expect, it } from 'vitest';
import { planSyncActionsFromChanges } from './changesPlanner';
import type { ApiChangeEntry } from './apiTypes';

describe('planSyncActionsFromChanges', () => {
    it('plans session catch-up and invalidations', () => {
        const changes: ApiChangeEntry[] = [
            { cursor: 1, kind: 'session', entityId: 's1', changedAt: 1, hint: null },
            { cursor: 2, kind: 'share', entityId: 's2', changedAt: 2, hint: null },
            { cursor: 3, kind: 'machine', entityId: 'm1', changedAt: 3, hint: null },
            { cursor: 4, kind: 'artifact', entityId: 'a1', changedAt: 4, hint: null },
            { cursor: 5, kind: 'account', entityId: 'self', changedAt: 5, hint: null },
            { cursor: 6, kind: 'friends', entityId: 'self', changedAt: 6, hint: null },
            { cursor: 7, kind: 'feed', entityId: 'self', changedAt: 7, hint: null },
        ];

        const planned = planSyncActionsFromChanges(changes);
        expect(planned.sessionIdsToCatchUp).toEqual(['s1', 's2']);
        expect(planned.invalidate).toEqual({
            sessions: true,
            machines: true,
            artifacts: true,
            settings: true,
            profile: true,
            friends: true,
            feed: true,
        });
        expect(planned.kv).toEqual({ type: 'none' });
    });

    it('plans KV bulk keys when hint.keys present', () => {
        const changes: ApiChangeEntry[] = [
            { cursor: 1, kind: 'kv', entityId: 'self', changedAt: 1, hint: { keys: ['todo.index', 'todo.a'] } },
        ];
        const planned = planSyncActionsFromChanges(changes);
        expect(planned.kv).toEqual({ type: 'bulk-keys', feature: 'todos', keys: ['todo.a', 'todo.index'] });
    });

    it('plans KV refresh when hint.full is true or invalid', () => {
        const plannedFull = planSyncActionsFromChanges([
            { cursor: 1, kind: 'kv', entityId: 'self', changedAt: 1, hint: { full: true } },
        ]);
        expect(plannedFull.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });

        const plannedInvalid = planSyncActionsFromChanges([
            { cursor: 1, kind: 'kv', entityId: 'self', changedAt: 1, hint: { nope: true } },
        ]);
        expect(plannedInvalid.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });
    });
});

