import { describe, expect, it } from 'vitest';
import { ChangeKindSchema } from '@happier-dev/protocol/changes';
import { CHANGE_CHECKPOINT_COVERAGE, classifyChangeForCheckpoint, planSyncActionsFromChanges } from './changesPlanner';
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
            pets: false,
            sessionFolderAssignments: false,
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

    it('deduplicates session catch-up ids', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
            buildChange({ cursor: 2, kind: 'share', entityId: 's1' }),
            buildChange({ cursor: 3, kind: 'session', entityId: '' }),
        ]);

        expect(planned.sessionIdsToCatchUp).toEqual(['s1']);
        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.invalidate.automations).toBe(false);
        expect(planned.kv).toEqual({ type: 'none' });
    });

    it('plans explicit session folder assignment refreshes without message catch-up', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'session',
                entityId: 's1',
                hint: { sessionFolderAssignment: true, folderId: 'folder-a' },
            }),
            buildChange({
                cursor: 2,
                kind: 'account',
                entityId: 'session-folder-assignments',
                hint: { sessionFolderAssignments: true, folderIds: ['folder-a'] },
            }),
        ]);

        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionFolderAssignmentSessionIds).toEqual(['s1']);
        expect(planned.invalidate.sessionFolderAssignments).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });

    it('plans scoped session organization snapshot refreshes', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: {
                    sessionOrganization: true,
                    scope: 'labels',
                    sessionIds: ['s1'],
                    folderIds: ['folder-a'],
                    tagIds: ['tag-a'],
                    orderScopes: [{ scopeKind: 'workspace', scopeKey: 'server-a' }],
                },
            }),
        ]);

        expect(planned.sessionOrganization).toEqual({
            mode: 'snapshot',
            assignmentSessionIds: ['s1'],
            folderIds: ['folder-a'],
            tagIds: ['tag-a'],
            orderScopes: [{ scopeKind: 'workspace', scopeKey: 'server-a' }],
            includeFolders: false,
            includeTags: false,
            includeLabels: true,
        });
        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
    });

    it('plans a session-list refresh for pin organization hints without message catch-up', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'pins', sessionIds: ['s-pin'] },
            }),
        ]);

        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionOrganization).toMatchObject({
            mode: 'snapshot',
            assignmentSessionIds: ['s-pin'],
        });
    });

    it('records unknown kinds as unsupported without treating them as safe invalidations', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 4, kind: 'unknown-change-kind' as ApiChangeEntry['kind'] }),
        ]);

        expect(planned.unsupportedChanges).toEqual([
            { cursor: '4', kind: 'unknown-change-kind', entityId: 'self' },
        ]);
        expect(planned.invalidate.sessions).toBe(false);
    });

    it('maps every protocol change kind in the checkpoint coverage matrix', () => {
        expect(Object.keys(CHANGE_CHECKPOINT_COVERAGE).sort()).toEqual([...ChangeKindSchema.options].sort());
    });

    it('classifies every session shell change as critical regardless of transcript load state', () => {
        const loaded = classifyChangeForCheckpoint(
            buildChange({ cursor: 1, kind: 'session', entityId: 'loaded' }),
            { isSessionMessagesLoaded: (sessionId) => sessionId === 'loaded' },
        );
        const unloaded = classifyChangeForCheckpoint(
            buildChange({ cursor: 2, kind: 'session', entityId: 'unloaded' }),
            { isSessionMessagesLoaded: () => false },
        );

        expect(loaded.decision).toBe('critical');
        expect(unloaded.decision).toBe('critical');
    });

    it('plans automation invalidation when automation change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'automation', entityId: 'a1' }),
        ]);

        expect(planned.invalidate.automations).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);
    });

    it('plans account pet invalidation when pet change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'pet', entityId: 'pet-1' }),
        ]);

        expect(planned.invalidate.pets).toBe(true);
        expect(planned.invalidate.settings).toBe(false);
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
