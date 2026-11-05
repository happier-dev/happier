import { InvalidateSync } from '@/utils/sessions/sync';
import { createDeferred } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { applyPlannedChangeActions } from './changesApplier';
import { planSyncActionsFromChanges, type PlannedChangeActions } from './changesPlanner';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { buildConnectedServicesAccountChangeV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

const credentials: AuthCredentials = { token: 't', secret: 's' };

type ExtendedPlannedChangeActions = Omit<PlannedChangeActions, 'invalidate'> & {
    sessionFolderAssignmentSessionIds: string[];
    invalidate: PlannedChangeActions['invalidate'] & {
        sessionFolderAssignments: boolean;
    };
};

function buildPlanned(partial: {
    changes?: ApiChangeEntry[];
    workflowRunIdsToRefresh?: string[];
    sessionIdsToCatchUp?: string[];
    sessionRowRefreshIds?: string[];
    sessionTranscriptRepairs?: PlannedChangeActions['sessionTranscriptRepairs'];
    sessionFolderAssignmentSessionIds?: string[];
    sessionOrganization?: PlannedChangeActions['sessionOrganization'];
    unsupportedChanges?: PlannedChangeActions['unsupportedChanges'];
    invalidate?: Partial<ExtendedPlannedChangeActions['invalidate']>;
    kv?: PlannedChangeActions['kv'];
    sessionDraftAddresses?: PlannedChangeActions['sessionDraftAddresses'];
}): ExtendedPlannedChangeActions {
    return {
        changes: partial.changes ?? [],
        machineResourcesAffect: planSyncActionsFromChanges(partial.changes ?? []).machineResourcesAffect,
        managedMachineInventoryAffect: planSyncActionsFromChanges(partial.changes ?? []).managedMachineInventoryAffect,
        workflowRunIdsToRefresh: partial.workflowRunIdsToRefresh ?? [],
        sessionIdsToCatchUp: partial.sessionIdsToCatchUp ?? [],
        sessionRowRefreshIds: partial.sessionRowRefreshIds ?? [],
        sessionTranscriptRepairs: partial.sessionTranscriptRepairs ?? [],
        sessionFolderAssignmentSessionIds: partial.sessionFolderAssignmentSessionIds ?? [],
        sessionOrganization: partial.sessionOrganization ?? { mode: 'none' },
        unsupportedChanges: partial.unsupportedChanges ?? [],
        invalidate: {
            sessions: false,
            sessionFolderAssignments: false,
            machines: false,
            machinePools: false,
            artifacts: false,
            settings: false,
            profile: false,
            friends: false,
            feed: false,
            automations: false,
            pets: false,
            savedSecretResources: false,
            ...(partial.invalidate ?? {}),
        },
        kv: partial.kv ?? { type: 'none' },
        sessionDraftAddresses: partial.sessionDraftAddresses ?? [],
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
    it('drains a retired real queue wait without admitting queued actions or a safe checkpoint', async () => {
        // The deferred reply is the HTTP boundary; the planner, queue and applier stay real.
        const reply = createDeferred<void>();
        const started = createDeferred<void>();
        const queue = new InvalidateSync(async () => { started.resolve(); await reply.promise; });
        const controller = new AbortController();
        let current = true;
        let profileReads = 0;
        const changes = [buildChange({ cursor: 8, kind: 'account' })];
        const apply = applyPlannedChangeActions({
            planned: planSyncActionsFromChanges(changes), credentials,
            shouldContinue: () => current, concurrencyLimit: 1,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                settings: () => queue.invalidateAndAwait({ signal: controller.signal }),
                profile: async () => { profileReads++; },
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });
        try {
            await started.promise;
            current = false;
            controller.abort();
            await expect(apply).resolves.toMatchObject({
                status: 'partial', safeAdvanceCursor: null, processedChanges: 0, blockedCursor: '8',
            });
            expect(profileReads).toBe(0);
        } finally {
            reply.resolve();
            await queue.awaitQueue();
            await apply;
        }
    });

    it('materializes a connected-service page once without Settings reads and preserves the next settings-only refresh', async () => {
        const reads = { settings: 0, profile: 0, savedSecretResources: 0 };
        const apply = (changes: ApiChangeEntry[]) => applyPlannedChangeActions({
            planned: planSyncActionsFromChanges(changes),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                settings: async () => { reads.settings++; },
                profile: async () => { reads.profile++; },
                savedSecretResources: async () => { reads.savedSecretResources++; },
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });
        const changes = Array.from({ length: 27 }, (_, index) => buildChange({
            cursor: index + 1,
            ...buildConnectedServicesAccountChangeV1({ pluginId: 'acme.accounts', localId: `service-${index}` }),
        }));
        expect(await apply(changes)).toMatchObject({ status: 'complete', safeAdvanceCursor: '27' });
        expect(reads).toEqual({ settings: 0, profile: 1, savedSecretResources: 1 });
        expect(await apply([buildChange({ cursor: 28, kind: 'account', hint: { settingsVersion: 9 } })]))
            .toMatchObject({ status: 'complete', safeAdvanceCursor: '28' });
        expect(reads).toEqual({ settings: 1, profile: 2, savedSecretResources: 1 });
    });

    it('checkpoints a hydrated session when its history reader deliberately defers newer content', async () => {
        let deferred = false;
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [buildChange({ cursor: 1, kind: 'session', entityId: 's1', hint: { lastMessageSeq: 900 } })],
                sessionIdsToCatchUp: ['s1'],
                invalidate: { sessions: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            shouldCatchUpSessionMessages: () => true,
            getSessionMaterializedMaxSeq: () => 100,
            isSessionMessagesDeferred: () => deferred,
            invalidate: { sessions: async () => {} },
            invalidateMessagesForSession: async () => { deferred = true; },
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '1', blockedChanges: 0 });
    });
    it('refreshes every workflow Run of a page with one batched read before advancing its Account changes', async () => {
        const refreshWorkflowRuns = vi.fn(async () => {});
        const changes = ['run-42', 'run-43', 'run-44'].map((runId, index) =>
            buildChange({ cursor: index + 1, kind: 'account', entityId: `workflow-run:${runId}` }));
        const result = await applyPlannedChangeActions({
            planned: planSyncActionsFromChanges(changes),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            refreshWorkflowRuns,
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(refreshWorkflowRuns).toHaveBeenCalledTimes(1);
        expect([...(refreshWorkflowRuns.mock.calls[0] as unknown as [readonly string[]])[0]].sort()).toEqual(['run-42', 'run-43', 'run-44']);
        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '3' });
    });

    it('holds a workflow Run change cursor when its exact refresh owner is unavailable', async () => {
        const change = buildChange({ cursor: 1, kind: 'account', entityId: 'workflow-run:run-42' });

        const result = await applyPlannedChangeActions({
            planned: planSyncActionsFromChanges([change]),
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
            blockedReason: 'partial-materialization',
        });
    });

    it('holds a workflow Run change cursor when its exact refresh fails', async () => {
        const change = buildChange({ cursor: 1, kind: 'account', entityId: 'workflow-run:run-42' });

        const result = await applyPlannedChangeActions({
            planned: planSyncActionsFromChanges([change]),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            refreshWorkflowRuns: async () => { throw new Error('offline'); },
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

    it('holds a Saved Secret resource cursor until the catalog refresh succeeds', async () => {
        const planned = planSyncActionsFromChanges([buildChange({
            cursor: 1,
            kind: 'savedSecretResource',
            entityId: 'resource-a',
        })]);
        let refreshFails = true;
        const apply = () => applyPlannedChangeActions({
            planned,
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                savedSecretResources: async () => {
                    if (refreshFails) throw new Error('offline');
                },
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(await apply()).toMatchObject({
            status: 'partial',
            safeAdvanceCursor: null,
            blockedCursor: '1',
            blockedReason: 'partial-materialization',
        });
        refreshFails = false;
        expect(await apply()).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
    });

    it('holds a Teams membership cursor until Saved Secret authorization is re-observed', async () => {
        const planned = planSyncActionsFromChanges([buildChange({
            cursor: 1,
            kind: 'account',
            entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1,
        })]);

        const result = await applyPlannedChangeActions({
            planned,
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                savedSecretResources: async () => { throw new Error('offline'); },
            },
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

    it('holds a Machine Pool change cursor until the exact Home projection refresh succeeds', async () => {
        const planned = planSyncActionsFromChanges([buildChange({
            cursor: 1,
            kind: 'machinePool',
            entityId: 'pool-a',
        })]);
        let refreshFails = true;
        const apply = () => applyPlannedChangeActions({
            planned,
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { machinePools: async () => { if (refreshFails) throw new Error('offline'); } },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(await apply()).toMatchObject({
            status: 'partial', safeAdvanceCursor: null, blockedCursor: '1', blockedReason: 'partial-materialization',
        });
        refreshFails = false;
        expect(await apply()).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
    });

    it('holds a Follow change cursor until Session relevance refresh succeeds', async () => {
        const planned = planSyncActionsFromChanges([buildChange({
            cursor: 1,
            kind: 'account',
            entityId: 'session-follows',
            hint: { sessionFollows: true, full: true },
        })]);
        let refreshFails = true;
        const apply = () => applyPlannedChangeActions({
            planned,
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { sessions: async () => { if (refreshFails) throw new Error('offline'); } },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });
        expect(await apply()).toMatchObject({
            status: 'partial', safeAdvanceCursor: null, blockedCursor: '1', blockedReason: 'partial-materialization',
        });
        refreshFails = false;
        expect(await apply()).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
    });

    it('materializes an exact SessionDraft before advancing its AccountChange cursor', async () => {
        const address = { kind: 'session', sessionId: 'session-a' } as const;
        const change = buildChange({
            cursor: 1,
            kind: 'account',
            hint: { v: 1, sessionDraft: true, address, revision: 2, status: 'present' },
        });
        const materializeSessionDraft = vi.fn(async () => {});

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({ changes: [change], sessionDraftAddresses: [address] }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            materializeSessionDraft,
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(materializeSessionDraft).toHaveBeenCalledWith(address);
        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
    });

    it('keeps successful and failed sibling Run draft materialization distinct', async () => {
        const first = { kind: 'run', sessionId: 'session-a', runId: 'run-a' } as const;
        const second = { ...first, runId: 'run-b' };
        const changes = [first, second].map((address, index) => buildChange({
            cursor: index + 1, kind: 'account',
            hint: { v: 2, sessionDraftV2: true, address, revision: 2, status: 'present' },
        }));
        const result = await applyPlannedChangeActions({
            planned: planSyncActionsFromChanges(changes),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            materializeSessionDraft: async (address) => {
                if (address.kind === 'run' && address.runId === 'run-b') throw new Error('offline');
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });
        expect(result).toMatchObject({
            status: 'partial', safeAdvanceCursor: '1', blockedCursor: '2', blockedReason: 'partial-materialization',
        });
    });

    it('holds the cursor when exact SessionDraft materialization fails', async () => {
        const address = { kind: 'session', sessionId: 'session-a' } as const;
        const change = buildChange({
            cursor: 1,
            kind: 'account',
            hint: { v: 1, sessionDraft: true, address, revision: 2, status: 'deleted' },
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({ changes: [change], sessionDraftAddresses: [address] }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            materializeSessionDraft: async () => { throw new Error('offline'); },
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

    it('hands closed plugin collection invalidations to the Data-owned direct-client producer before advancing the cursor', async () => {
        const publishAccountChanges = vi.fn();
        const change = buildChange({
            cursor: 1,
            kind: 'pluginDomain',
            entityId: 'pluginDomain/example.tasks/data-collection/tasks',
            hint: {
                pluginDomain: 'dataCollection',
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                contractDigest: 'a'.repeat(43),
                revision: 1,
                full: true,
            },
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({ changes: [change] }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            publishAccountChanges,
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(publishAccountChanges).toHaveBeenCalledWith([change]);
        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
    });

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

    it('blocks pet change cursor advancement when account pet materialization fails', async () => {
        const invalidatePets = vi.fn(async () => {
            throw new Error('pets unavailable');
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'pet', entityId: 'pet-1' }),
                    buildChange({ cursor: 2, kind: 'account', entityId: 'self' }),
                ],
                invalidate: { pets: true, settings: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                pets: invalidatePets,
                settings: async () => {},
            },
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

    it('refreshes listed rows by id instead of the list, and holds the cursor until they land', async () => {
        const planned = planSyncActionsFromChanges([
            buildChange({ cursor: 1, kind: 'session', entityId: 'listed', hint: { lastMessageSeq: 4, lastMessageId: 'm4' } }),
        ], { isSessionListMember: (sessionId) => sessionId === 'listed' });
        const invalidateSessions = vi.fn(async () => {});
        let rowRefreshFails = true;
        const refreshSessionRows = vi.fn(async (_sessionIds: readonly string[]) => {
            if (rowRefreshFails) throw new Error('offline');
        });
        const apply = () => applyPlannedChangeActions({
            planned,
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { sessions: invalidateSessions, sessionRows: refreshSessionRows },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(await apply()).toMatchObject({ status: 'partial', blockedCursor: '1', blockedReason: 'partial-materialization' });
        rowRefreshFails = false;
        expect(await apply()).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
        expect(refreshSessionRows).toHaveBeenLastCalledWith(['listed']);
        expect(invalidateSessions).not.toHaveBeenCalled();
    });

    it('requires shell hydration for every changed session while limiting transcript catch-up to loaded sessions', async () => {
        const invalidateSessions = vi.fn(async (_context: {
            requiredHydrationSessionIds: readonly string[];
            prioritizeSessionIds: readonly string[];
        }) => {});

        await applyPlannedChangeActions({
            planned: buildPlanned({
                sessionIdsToCatchUp: ['loaded', 'unloaded'],
                invalidate: { sessions: true },
            }),
            credentials,
            isSessionMessagesLoaded: (sessionId) => sessionId === 'loaded',
            invalidate: {
                sessions: invalidateSessions,
            },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(invalidateSessions).toHaveBeenCalledWith({
            requiredHydrationSessionIds: ['loaded', 'unloaded'],
            prioritizeSessionIds: ['loaded', 'unloaded'],
        });
    });

    it('refreshes session folder assignments without requiring message materialization', async () => {
        const invalidateSessionFolderAssignments = vi.fn(async () => {});
        const invalidateMessagesForSession = vi.fn(async () => {});
        const invalidateSessions = vi.fn(async () => {});

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({
                        cursor: 1,
                        kind: 'session',
                        entityId: 's1',
                        hint: { sessionFolderAssignment: true, folderId: 'folder-a' },
                    }),
                ],
                sessionFolderAssignmentSessionIds: ['s1'],
                invalidate: { sessionFolderAssignments: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            invalidate: {
                sessions: invalidateSessions,
                sessionFolderAssignments: invalidateSessionFolderAssignments,
            } as Parameters<typeof applyPlannedChangeActions>[0]['invalidate'] & {
                sessionFolderAssignments: () => Promise<void>;
            },
            invalidateMessagesForSession,
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
        expect(invalidateSessionFolderAssignments).toHaveBeenCalledWith(['s1']);
        expect(invalidateSessions).not.toHaveBeenCalled();
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('blocks assignment cursor advancement when assignment refresh fails', async () => {
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({
                        cursor: 1,
                        kind: 'session',
                        entityId: 's1',
                        hint: { sessionFolderAssignment: true, folderId: 'folder-a' },
                    }),
                ],
                sessionFolderAssignmentSessionIds: ['s1'],
                invalidate: { sessionFolderAssignments: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            invalidate: {
                sessionFolderAssignments: async () => {
                    throw new Error('assignment refresh failed');
                },
            } as Parameters<typeof applyPlannedChangeActions>[0]['invalidate'] & {
                sessionFolderAssignments: () => Promise<void>;
            },
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

    it('refreshes session organization snapshots and advances organization change cursors', async () => {
        const refreshSessionOrganization = vi.fn(async () => {});
        const applyAuthoritativeSessionOrganizationDeletions = vi.fn();

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({
                        cursor: 1,
                        kind: 'account',
                        entityId: 'session-organization',
                        hint: { sessionOrganization: true, scope: 'folders', folderIds: ['folder-a'] },
                    }),
                ],
                sessionOrganization: {
                    mode: 'snapshot',
                    assignmentSessionIds: [],
                    folderIds: ['folder-a'],
                    tagIds: [],
                    deletedTagIds: ['deleted-tag'],
                    orderScopes: [],
                    includeFolders: true,
                    includeTags: false,
                    includeLabels: false,
                },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            refreshSessionOrganization,
            applyAuthoritativeSessionOrganizationDeletions,
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(refreshSessionOrganization).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'snapshot',
            folderIds: ['folder-a'],
            includeFolders: true,
        }));
        expect(applyAuthoritativeSessionOrganizationDeletions).toHaveBeenCalledWith(expect.objectContaining({
            deletedTagIds: ['deleted-tag'],
        }));
        expect(result).toEqual({
            status: 'complete',
            safeAdvanceCursor: '1',
            processedChanges: 1,
            blockedChanges: 0,
        });
    });

    it('does not apply authoritative organization deletions when snapshot refresh fails', async () => {
        const applyAuthoritativeSessionOrganizationDeletions = vi.fn();

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [buildChange({
                    cursor: 1,
                    kind: 'account',
                    entityId: 'session-organization',
                    hint: {
                        sessionOrganization: true,
                        scope: 'tags',
                        tagIds: ['deleted-tag'],
                        deletedTagIds: ['deleted-tag'],
                    },
                })],
                sessionOrganization: {
                    mode: 'snapshot',
                    assignmentSessionIds: [],
                    folderIds: [],
                    tagIds: ['deleted-tag'],
                    deletedTagIds: ['deleted-tag'],
                    orderScopes: [],
                    includeFolders: false,
                    includeTags: true,
                    includeLabels: false,
                },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {},
            refreshSessionOrganization: async () => {
                throw new Error('offline');
            },
            applyAuthoritativeSessionOrganizationDeletions,
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(applyAuthoritativeSessionOrganizationDeletions).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            status: 'partial',
            blockedReason: 'partial-materialization',
        });
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
            isSessionMessagesDeferred: () => true,
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

    it('refreshes the exact changed Artifact ids once before checkpointing', async () => {
        const refreshArtifacts = vi.fn(async (_artifactIds: readonly string[]) => {});
        const changes = [
            buildChange({ cursor: 1, kind: 'artifact', entityId: 'artifact-b' }),
            buildChange({ cursor: 2, kind: 'artifact', entityId: 'artifact-a' }),
            buildChange({ cursor: 3, kind: 'artifact', entityId: 'artifact-b' }),
        ];

        const result = await applyPlannedChangeActions({
            planned: planSyncActionsFromChanges(changes),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: { artifacts: refreshArtifacts },
            invalidateMessagesForSession: async () => {},
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(refreshArtifacts).toHaveBeenCalledOnce();
        expect(refreshArtifacts).toHaveBeenCalledWith(['artifact-a', 'artifact-b']);
        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '3' });
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

    it('returns the contiguous safe cursor before an unsupported change', async () => {
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
            isSessionMessagesDeferred: () => true,
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

    it('blocks unloaded session advancement when the session snapshot invalidation fails', async () => {
        const invalidateSessions = vi.fn(async () => {
            throw new Error('snapshot unavailable');
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 's1' }),
                ],
                sessionIdsToCatchUp: ['s1'],
                invalidate: { sessions: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => false,
            invalidate: {
                sessions: invalidateSessions,
            },
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

    it('advances after session-shell hydration without catching up a hidden loaded transcript', async () => {
        const invalidateMessagesForSession = vi.fn(async () => {});
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({ cursor: 1, kind: 'session', entityId: 's1', hint: { lastMessageSeq: 120 } }),
                ],
                sessionIdsToCatchUp: ['s1'],
                invalidate: { sessions: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            shouldCatchUpSessionMessages: () => false,
            getSessionMaterializedMaxSeq: () => 119,
            invalidate: { sessions: async () => {} },
            invalidateMessagesForSession,
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        } as Parameters<typeof applyPlannedChangeActions>[0]);

        expect(result).toEqual({
            status: 'complete',
            safeAdvanceCursor: '1',
            processedChanges: 1,
            blockedChanges: 0,
        });
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
    });

    it('still repairs an edited row in a hidden loaded transcript without running bulk newer catch-up', async () => {
        const invalidateMessagesForSession = vi.fn(async () => {});
        const repairSessionTranscriptRevision = vi.fn(async () => {});
        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [
                    buildChange({
                        cursor: 1,
                        kind: 'session',
                        entityId: 's1',
                        hint: { lastMessageSeq: 120, updatedMessageSeq: 15, updatedMessageId: 'm15' },
                    }),
                ],
                sessionIdsToCatchUp: ['s1'],
                sessionTranscriptRepairs: [{ sessionId: 's1', minSeq: 15, messageIds: ['m15'] }],
                invalidate: { sessions: true },
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            shouldCatchUpSessionMessages: () => false,
            getSessionMaterializedMaxSeq: () => 15,
            invalidate: { sessions: async () => {} },
            invalidateMessagesForSession,
            repairSessionTranscriptRevision,
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        } as Parameters<typeof applyPlannedChangeActions>[0]);

        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
        expect(invalidateMessagesForSession).not.toHaveBeenCalled();
        expect(repairSessionTranscriptRevision).toHaveBeenCalledWith({
            sessionId: 's1',
            minSeq: 15,
            messageIds: ['m15'],
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

    it('repairs durable in-place transcript revisions before advancing their cursor', async () => {
        const repairSessionTranscriptRevision = vi.fn(async () => {});
        const change = buildChange({
            cursor: 1,
            kind: 'session',
            entityId: 's1',
            hint: { updatedMessageSeq: 15, updatedMessageId: 'm15' },
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [change],
                sessionIdsToCatchUp: ['s1'],
                sessionTranscriptRepairs: [{ sessionId: 's1', minSeq: 15, messageIds: ['m15'] }],
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            getSessionMaterializedMaxSeq: () => 15,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            repairSessionTranscriptRevision,
            invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {},
            kvBulkGet: async () => ({ values: [] }),
        });

        expect(repairSessionTranscriptRevision).toHaveBeenCalledWith({
            sessionId: 's1',
            minSeq: 15,
            messageIds: ['m15'],
        });
        expect(result).toMatchObject({ status: 'complete', safeAdvanceCursor: '1' });
    });

    it('keeps the changes cursor before a durable transcript revision whose repair fails', async () => {
        const change = buildChange({
            cursor: 1,
            kind: 'session',
            entityId: 's1',
            hint: { updatedMessageSeq: 15, updatedMessageId: 'm15' },
        });

        const result = await applyPlannedChangeActions({
            planned: buildPlanned({
                changes: [change],
                sessionIdsToCatchUp: ['s1'],
                sessionTranscriptRepairs: [{ sessionId: 's1', minSeq: 15, messageIds: ['m15'] }],
            }),
            credentials,
            isSessionMessagesLoaded: () => true,
            isSessionMessagesDeferred: () => true,
            getSessionMaterializedMaxSeq: () => 15,
            invalidate: {},
            invalidateMessagesForSession: async () => {},
            repairSessionTranscriptRevision: async () => {
                throw new Error('revision fetch failed');
            },
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
