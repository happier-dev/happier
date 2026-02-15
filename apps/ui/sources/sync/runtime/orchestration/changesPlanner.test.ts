import { describe, expect, it } from 'vitest';
import { planSyncActionsFromChanges } from './changesPlanner';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';

function buildChange(params: {
    cursor: number;
    kind: ApiChangeEntry['kind'];
    entityId?: ApiChangeEntry['entityId'];
    changedAt?: number;
    hint?: ApiChangeEntry['hint'];
}): ApiChangeEntry {
    return {
        cursor: params.cursor,
        kind: params.kind,
        entityId: params.entityId ?? 'self',
        changedAt: params.changedAt ?? params.cursor,
        hint: params.hint ?? null,
    };
}

describe('planSyncActionsFromChanges', () => {
    it('plans session catch-up and invalidations', () => {
        const changes: ApiChangeEntry[] = [
            buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
            buildChange({ cursor: 2, kind: 'share', entityId: 's2' }),
            buildChange({ cursor: 3, kind: 'machine', entityId: 'm1' }),
            buildChange({ cursor: 4, kind: 'artifact', entityId: 'a1' }),
            buildChange({ cursor: 5, kind: 'account', entityId: 'self' }),
            buildChange({ cursor: 6, kind: 'friends', entityId: 'self' }),
            buildChange({ cursor: 7, kind: 'feed', entityId: 'self' }),
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
            automations: false,
        });
        expect(planned.kv).toEqual({ type: 'none' });
    });

    it('plans KV bulk keys when hint.keys present', () => {
        const changes: ApiChangeEntry[] = [
            buildChange({ cursor: 1, kind: 'kv', hint: { keys: ['todo.index', 'todo.a'] } }),
        ];
        const planned = planSyncActionsFromChanges(changes);
        expect(planned.kv).toEqual({ type: 'bulk-keys', feature: 'todos', keys: ['todo.a', 'todo.index'] });
    });

    it('plans KV refresh when hint.full is true or invalid', () => {
        const plannedFull = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'kv', hint: { full: true } }),
        ]);
        expect(plannedFull.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });

        const plannedInvalid = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'kv', hint: { nope: true } as ApiChangeEntry['hint'] }),
        ]);
        expect(plannedInvalid.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });
    });

    it('deduplicates session catch-up ids and handles unknown kinds as safe session invalidations', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
            buildChange({ cursor: 2, kind: 'share', entityId: 's1' }),
            buildChange({ cursor: 3, kind: 'session', entityId: '' }),
            buildChange({ cursor: 4, kind: 'unknown-change-kind' as ApiChangeEntry['kind'] }),
        ]);

        expect(planned.sessionIdsToCatchUp).toEqual(['s1']);
        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.invalidate.automations).toBe(false);
        expect(planned.kv).toEqual({ type: 'none' });
    });

    it('plans automation invalidation when automation change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'automation', entityId: 'a1' }),
        ]);

        expect(planned.invalidate.automations).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);
    });

    it('plans deduplicated KV keys and upgrades to full refresh when any KV change requires it', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'kv',
                hint: { keys: ['todo.b', '', 'todo.a', 'todo.b'] },
            }),
            buildChange({
                cursor: 2,
                kind: 'kv',
                hint: ['not-a-record'] as unknown as ApiChangeEntry['hint'],
            }),
        ]);

        expect(planned.kv).toEqual({ type: 'refresh-feature', feature: 'todos' });
    });
});
