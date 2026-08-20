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

    it('plans exact transcript revision repair from durable message-update hints', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'session',
                entityId: 's1',
                hint: { updatedMessageSeq: 15, updatedMessageId: 'm15' },
            }),
            buildChange({
                cursor: 2,
                kind: 'session',
                entityId: 's1',
                hint: { updatedMessageSeq: 10, updatedMessageId: 'm10' },
            }),
        ]);

        expect(planned.sessionTranscriptRepairs).toEqual([{
            sessionId: 's1',
            minSeq: 10,
            messageIds: ['m10', 'm15'],
        }]);
    });

    it('plans session folder assignment refresh without session materialization', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'session',
                entityId: 's1',
                hint: { sessionFolderAssignment: true, folderId: 'folder-a' },
            }),
        ]);

        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.invalidate.sessions).toBe(false);
        expect(planned.sessionFolderAssignments).toEqual({
            mode: 'sessions',
            sessionIds: ['s1'],
            folderIds: ['folder-a'],
        });
        expect(planned.sessionOrganization).toEqual({
            mode: 'snapshot',
            assignmentSessionIds: ['s1'],
            folderIds: ['folder-a'],
            tagIds: [],
            orderScopes: [],
            includeFolders: false,
            includeTags: false,
            includeLabels: false,
        });
    });

    it('plans bulk session folder assignment refresh from account hints', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-folder-assignments',
                hint: { sessionFolderAssignments: true, folderIds: ['folder-b', '', 'folder-a', 'folder-a'] },
            }),
        ]);

        expect(planned.invalidate.settings).toBe(false);
        expect(planned.invalidate.profile).toBe(false);
        expect(planned.sessionFolderAssignments).toEqual({
            mode: 'folders',
            folderIds: ['folder-a', 'folder-b'],
        });
        expect(planned.sessionOrganization).toEqual({
            mode: 'snapshot',
            assignmentSessionIds: [],
            folderIds: ['folder-a', 'folder-b'],
            tagIds: [],
            orderScopes: [],
            includeFolders: false,
            includeTags: false,
            includeLabels: false,
        });
    });

    it('plans scoped session organization refresh from organization hints', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: {
                    sessionOrganization: true,
                    scope: 'order',
                    sessionIds: ['s2', 's1', 's1'],
                    folderIds: ['folder-a'],
                    tagIds: ['tag-a'],
                    orderScopes: [{ scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo' }],
                },
            }),
        ]);

        expect(planned.invalidate.settings).toBe(false);
        expect(planned.sessionOrganization).toEqual({
            mode: 'snapshot',
            assignmentSessionIds: ['s1', 's2'],
            folderIds: ['folder-a'],
            tagIds: ['tag-a'],
            orderScopes: [{ scopeKind: 'group', scopeKey: 'server:server-a:active:project:repo' }],
            includeFolders: false,
            includeTags: false,
            includeLabels: false,
        });
    });

    it('plans actual server session organization scope hints as scoped snapshot refreshes', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'pins', sessionIds: ['s-pin'] },
            }),
            buildChange({
                cursor: 2,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'folders', folderIds: ['folder-a'] },
            }),
            buildChange({
                cursor: 3,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'tags', tagIds: ['tag-a'] },
            }),
            buildChange({
                cursor: 4,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'labels', scopeKeys: ['workspace-a'] },
            }),
            buildChange({
                cursor: 5,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'order', scopeKeys: ['root'] },
            }),
        ]);

        expect(planned.invalidate.settings).toBe(false);
        expect(planned.sessionFolderAssignments).toEqual({ mode: 'none' });
        expect(planned.sessionOrganization).toEqual({
            mode: 'snapshot',
            assignmentSessionIds: ['s-pin'],
            folderIds: ['folder-a'],
            tagIds: ['tag-a'],
            orderScopes: [],
            includeFolders: true,
            includeTags: true,
            includeLabels: true,
        });
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

    it('refreshes the session list for attention-standing organization hints the same way pins do', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({
                cursor: 1,
                kind: 'session',
                entityId: 's-standing',
                hint: { sessionOrganization: true, scope: 'attentionStandings', sessionIds: ['s-standing'] },
            }),
        ]);

        expect(planned.invalidate.sessions).toBe(true);
        expect(planned.sessionIdsToCatchUp).toEqual([]);
        expect(planned.sessionOrganization).toMatchObject({
            mode: 'snapshot',
            assignmentSessionIds: ['s-standing'],
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

    it('classifies every session shell as critical regardless of transcript load state', () => {
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

    it('classifies all session organization hints as critical organization materialization', () => {
        for (const change of [
            buildChange({
                cursor: 1,
                kind: 'account',
                entityId: 'session-organization',
                hint: { sessionOrganization: true, scope: 'pins', sessionIds: ['s1'] },
            }),
            buildChange({
                cursor: 2,
                kind: 'session',
                entityId: 's1',
                hint: { sessionOrganization: true, scope: 'tagAssignments', sessionIds: ['s1'], tagIds: ['tag-a'] },
            }),
            buildChange({
                cursor: 3,
                kind: 'account',
                entityId: 'session-folder-assignments',
                hint: { sessionFolderAssignments: true, sessionOrganization: true, scope: 'folderAssignments', folderIds: ['folder-a'] },
            }),
        ]) {
            expect(classifyChangeForCheckpoint(change, { isSessionMessagesLoaded: () => false })).toMatchObject({
                decision: 'critical',
                plannerOwner: 'session-organization',
                snapshotDomain: 'session-organization',
                materializationProof: 'session-organization',
            });
        }
    });

    it('plans automation invalidation when automation change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'automation', entityId: 'a1' }),
        ]);

        expect(planned.invalidate.automations).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);
    });

    it('plans pet library invalidation when pet change kind is present', () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'pet', entityId: 'pet-1' }),
        ]);

        expect(planned.invalidate.pets).toBe(true);
        expect(planned.invalidate.sessions).toBe(false);

        const classification = classifyChangeForCheckpoint(
            buildChange({ cursor: 1, kind: 'pet', entityId: 'pet-1' }),
            { isSessionMessagesLoaded: () => false },
        );
        expect(classification).toMatchObject({
            decision: 'critical',
            plannerOwner: 'pets',
            snapshotDomain: 'account-pets',
            materializationProof: 'account-pets',
        });
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
