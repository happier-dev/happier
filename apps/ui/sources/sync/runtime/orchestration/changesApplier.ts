import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    classifyChangeForCheckpoint,
    changeRequiresSavedSecretCatalogRefresh,
    getChangeSessionDraftHint,
    getChangeAuthoringMemoryHint,
    getChangeProjectAccountRowHint,
    getChangeTargetMessageSeq,
    type ChangeCheckpointBlockedReason,
    type PlannedChangeActions,
} from './changesPlanner';
import { runTasksWithLimit } from './runTasksWithLimit';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { canonicalSessionDraftAddressV2, type SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { readSessionUpdatedMessageChangeHintV1 } from '@happier-dev/protocol/changes';

export type TodoSocketUpdate = Readonly<{
    key: string;
    value: string | null;
    version: number;
}>;

export type PlannedChangesApplyResult =
    | Readonly<{
        status: 'complete';
        safeAdvanceCursor: string | null;
        processedChanges: number;
        blockedChanges: 0;
    }>
    | Readonly<{
        status: 'partial';
        safeAdvanceCursor: string | null;
        blockedCursor: string;
        blockedReason: ChangeCheckpointBlockedReason;
        processedChanges: number;
        blockedChanges: number;
    }>;

export type SessionListInvalidationContext = Readonly<{
    requiredHydrationSessionIds: readonly string[];
    prioritizeSessionIds: readonly string[];
}>;

export async function applyPlannedChangeActions(params: {
    planned: PlannedChangeActions;
    credentials: AuthCredentials;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    shouldCatchUpSessionMessages?: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq?: (sessionId: string) => number;
    isSessionMessagesDeferred?: (sessionId: string) => boolean;
    concurrencyLimit?: number;
    invalidate: {
        settings?: () => Promise<void>;
        profile?: () => Promise<void>;
        machines?: () => Promise<void>;
        machinePools?: () => Promise<void>;
        artifacts?: () => Promise<void>;
        friends?: () => Promise<void>;
        friendRequests?: () => Promise<void>;
        feed?: () => Promise<void>;
        automations?: () => Promise<void>;
        sessions?: (context: SessionListInvalidationContext) => Promise<void>;
        /** Refresh exactly these listed rows by id; the list membership is not re-read. */
        sessionRows?: (sessionIds: readonly string[]) => Promise<void>;
        sessionFolderAssignments?: (sessionIds: string[]) => Promise<void>;
        todos?: () => Promise<void>;
        pets?: () => Promise<void>;
        savedSecretResources?: () => Promise<void>;
    };
    refreshWorkflowRun?: (runId: string) => Promise<void>;
    refreshSessionOrganization?: (plan: Exclude<PlannedChangeActions['sessionOrganization'], { mode: 'none' }>) => Promise<void>;
    applyAuthoritativeSessionOrganizationDeletions?: (
        plan: Exclude<PlannedChangeActions['sessionOrganization'], { mode: 'none' }>,
    ) => void;
    /**
     * Each projection owner filters its own content-free invalidations. The shared
     * Account-change applier hands the canonical page to those owners before
     * checkpointing; this callback creates no second durable cursor.
     */
    publishAccountChanges?: (changes: readonly ApiChangeEntry[]) => void;
    invalidateMessagesForSession: (sessionId: string) => Promise<void>;
    repairSessionTranscriptRevision?: (repair: PlannedChangeActions['sessionTranscriptRepairs'][number]) => Promise<void>;
    invalidateScmStatusForSession: (sessionId: string) => void;
    applyTodoSocketUpdates: (changes: TodoSocketUpdate[]) => Promise<void>;
    kvBulkGet: (credentials: AuthCredentials, keys: string[]) => Promise<{ values: TodoSocketUpdate[] }>;
    convergePendingForSession?: (sessionId: string) => Promise<void>;
    materializeSessionDraft?: (address: SessionDraftAddressV2) => Promise<void>;
    materializeAuthoringMemory?: (key: string) => Promise<void>;
    materializeProjectAccountRow?: (physicalKey: string) => Promise<void>;
}): Promise<PlannedChangesApplyResult> {
    const { planned } = params;

    // Registering Data's wakeup before any awaited work preserves the
    // subscribe-then-initial-query race contract without giving UI a second
    // AccountChange broker or a collection query engine.
    params.publishAccountChanges?.(planned.changes);

    const concurrencyLimit = typeof params.concurrencyLimit === 'number' && params.concurrencyLimit > 0
        ? Math.trunc(params.concurrencyLimit)
        : 2;

    const tasks: Array<() => Promise<void>> = [];
    const completedWorkflowRunIds = new Set<string>();
    const failedWorkflowRunIds = new Set<string>();
    for (const runId of planned.workflowRunIdsToRefresh) {
        tasks.push(async () => {
            try {
                if (!params.refreshWorkflowRun) {
                    failedWorkflowRunIds.add(runId);
                    return;
                }
                await params.refreshWorkflowRun(runId);
                completedWorkflowRunIds.add(runId);
            } catch {
                failedWorkflowRunIds.add(runId);
            }
        });
    }
    const completedMessageCatchUpSessionIds = new Set<string>();
    const failedMessageCatchUpSessionIds = new Set<string>();
    const completedTranscriptRepairSessionIds = new Set<string>();
    const failedTranscriptRepairSessionIds = new Set<string>();
    const completedPendingSessionIds = new Set<string>();
    const failedPendingSessionIds = new Set<string>();
    const completedSessionDraftAddresses = new Set<string>();
    const failedSessionDraftAddresses = new Set<string>();
    const completedAuthoringMemoryKeys = new Set<string>();
    const completedProjectAccountRowKeys = new Set<string>();
    const listHydrationSessionIds = Array.from(new Set(
        planned.sessionIdsToCatchUp
            .map((sessionId) => String(sessionId ?? '').trim())
            .filter(Boolean),
    ));
    const loadedSessionIds = planned.sessionIdsToCatchUp.filter((sessionId) =>
        params.isSessionMessagesLoaded(sessionId),
    );
    const loadedCatchUpSessionIds = loadedSessionIds.filter((sessionId) =>
        params.shouldCatchUpSessionMessages?.(sessionId) !== false,
    );
    const loadedCatchUpSessionIdSet = new Set(loadedCatchUpSessionIds);
    const transcriptRepairBySessionId = new Map(
        planned.sessionTranscriptRepairs.map((repair) => [repair.sessionId, repair] as const),
    );

    let sessionsInvalidationFailed = false;
    let machinePoolsInvalidationFailed = false;
    let sessionFolderAssignmentsInvalidationFailed = false;
    let sessionOrganizationRefreshFailed = false;
    let petsInvalidationFailed = false;
    let savedSecretResourcesInvalidationFailed = false;
    let sessionsInvalidationDone: Promise<boolean> | null = null;
    let resolveSessionsInvalidationDone: ((succeeded: boolean) => void) | null = null;
    const sessionRowRefreshIds = planned.invalidate.sessions ? [] : planned.sessionRowRefreshIds;
    if (planned.invalidate.sessions || sessionRowRefreshIds.length > 0) {
        sessionsInvalidationDone = new Promise<boolean>((resolve) => {
            resolveSessionsInvalidationDone = resolve;
        });
    }

    if (planned.invalidate.settings) tasks.push(() => params.invalidate.settings?.() ?? Promise.resolve());
    if (planned.invalidate.profile) tasks.push(() => params.invalidate.profile?.() ?? Promise.resolve());
    if (planned.invalidate.machines) tasks.push(() => params.invalidate.machines?.() ?? Promise.resolve());
    if (planned.invalidate.machinePools) {
        tasks.push(async () => {
            try {
                if (!params.invalidate.machinePools) {
                    machinePoolsInvalidationFailed = true;
                    return;
                }
                await params.invalidate.machinePools();
            } catch {
                machinePoolsInvalidationFailed = true;
            }
        });
    }
    if (planned.invalidate.artifacts) tasks.push(() => params.invalidate.artifacts?.() ?? Promise.resolve());
    if (planned.invalidate.friends) {
        tasks.push(() => params.invalidate.friends?.() ?? Promise.resolve());
        tasks.push(() => params.invalidate.friendRequests?.() ?? Promise.resolve());
    }
    if (planned.invalidate.feed) tasks.push(() => params.invalidate.feed?.() ?? Promise.resolve());
    if (planned.invalidate.automations) tasks.push(() => params.invalidate.automations?.() ?? Promise.resolve());
    if (planned.invalidate.pets) {
        tasks.push(async () => {
            try {
                if (!params.invalidate.pets) {
                    petsInvalidationFailed = true;
                    return;
                }
                await params.invalidate.pets();
            } catch {
                petsInvalidationFailed = true;
            }
        });
    }
    if (planned.invalidate.savedSecretResources) {
        tasks.push(async () => {
            try {
                if (!params.invalidate.savedSecretResources) {
                    savedSecretResourcesInvalidationFailed = true;
                    return;
                }
                await params.invalidate.savedSecretResources();
            } catch {
                savedSecretResourcesInvalidationFailed = true;
            }
        });
    }
    if (planned.invalidate.sessions) {
        tasks.push(async () => {
            try {
                await params.invalidate.sessions?.({
                    requiredHydrationSessionIds: listHydrationSessionIds,
                    prioritizeSessionIds: listHydrationSessionIds,
                });
                resolveSessionsInvalidationDone?.(true);
            } catch {
                sessionsInvalidationFailed = true;
                resolveSessionsInvalidationDone?.(false);
            }
        });
    }
    if (sessionRowRefreshIds.length > 0) {
        tasks.push(async () => {
            try {
                // No row owner means these rows cannot be proven current: hold the cursor.
                if (!params.invalidate.sessionRows) throw new Error('Session row refresh owner unavailable');
                await params.invalidate.sessionRows(sessionRowRefreshIds);
                resolveSessionsInvalidationDone?.(true);
            } catch {
                sessionsInvalidationFailed = true;
                resolveSessionsInvalidationDone?.(false);
            }
        });
    }
    if (planned.invalidate.sessionFolderAssignments) {
        tasks.push(async () => {
            try {
                if (!params.invalidate.sessionFolderAssignments) {
                    sessionFolderAssignmentsInvalidationFailed = true;
                    return;
                }
                await params.invalidate.sessionFolderAssignments(planned.sessionFolderAssignmentSessionIds);
            } catch {
                sessionFolderAssignmentsInvalidationFailed = true;
            }
        });
    }
    const sessionOrganizationPlan = planned.sessionOrganization?.mode === 'snapshot'
        ? planned.sessionOrganization
        : null;
    if (sessionOrganizationPlan) {
        tasks.push(async () => {
            try {
                if (!params.refreshSessionOrganization) {
                    sessionOrganizationRefreshFailed = true;
                    return;
                }
                await params.refreshSessionOrganization(sessionOrganizationPlan);
                params.applyAuthoritativeSessionOrganizationDeletions?.(sessionOrganizationPlan);
            } catch {
                sessionOrganizationRefreshFailed = true;
            }
        });
    }

    for (const sessionId of loadedSessionIds) {
        const shouldCatchUpMessages = loadedCatchUpSessionIdSet.has(sessionId);
        const repair = transcriptRepairBySessionId.get(sessionId);
        if (!shouldCatchUpMessages && !repair) {
            params.invalidateScmStatusForSession(sessionId);
            continue;
        }
        tasks.push(async () => {
            if (sessionsInvalidationDone) {
                const sessionsInvalidated = await sessionsInvalidationDone;
                if (!sessionsInvalidated) {
                    if (shouldCatchUpMessages) {
                        failedMessageCatchUpSessionIds.add(sessionId);
                    }
                    if (repair) {
                        failedTranscriptRepairSessionIds.add(sessionId);
                    }
                    return;
                }
            }

            if (shouldCatchUpMessages) {
                try {
                    await params.invalidateMessagesForSession(sessionId);
                    completedMessageCatchUpSessionIds.add(sessionId);
                } catch {
                    failedMessageCatchUpSessionIds.add(sessionId);
                    return;
                }
            }

            if (repair) {
                try {
                    if (!params.repairSessionTranscriptRevision) {
                        failedTranscriptRepairSessionIds.add(sessionId);
                        return;
                    }
                    await params.repairSessionTranscriptRevision(repair);
                    completedTranscriptRepairSessionIds.add(sessionId);
                } catch {
                    failedTranscriptRepairSessionIds.add(sessionId);
                }
            }
        });
        params.invalidateScmStatusForSession(sessionId);
    }

    const pendingSessionIds = new Set<string>();
    for (const change of planned.changes) {
        const classification = classifyChangeForCheckpoint(change, {
            isSessionMessagesLoaded: params.isSessionMessagesLoaded,
        });
        if (classification.materializationProof === 'pending-queue-convergence') {
            pendingSessionIds.add(classification.entityId);
        }
    }

    for (const sessionId of pendingSessionIds) {
        tasks.push(async () => {
            try {
                if (!params.convergePendingForSession) {
                    failedPendingSessionIds.add(sessionId);
                    return;
                }
                await params.convergePendingForSession(sessionId);
                completedPendingSessionIds.add(sessionId);
            } catch {
                failedPendingSessionIds.add(sessionId);
            }
        });
    }

    for (const address of planned.sessionDraftAddresses ?? []) {
        tasks.push(async () => {
            const key = canonicalSessionDraftAddressV2(address);
            try {
                if (!params.materializeSessionDraft) {
                    failedSessionDraftAddresses.add(key);
                    return;
                }
                await params.materializeSessionDraft(address);
                completedSessionDraftAddresses.add(key);
            } catch {
                failedSessionDraftAddresses.add(key);
            }
        });
    }

    for (const key of planned.authoringMemoryKeys ?? []) {
        tasks.push(async () => {
            try {
                if (!params.materializeAuthoringMemory) return;
                await params.materializeAuthoringMemory(key);
                completedAuthoringMemoryKeys.add(key);
            } catch {
                // This row remains unmaterialized and the durable cursor stops below.
            }
        });
    }

    for (const key of planned.projectAccountRowKeys ?? []) {
        tasks.push(async () => {
            try {
                if (!params.materializeProjectAccountRow) return;
                await params.materializeProjectAccountRow(key);
                completedProjectAccountRowKeys.add(key);
            } catch {
                // The existing checkpoint remains below this unmaterialized row.
            }
        });
    }

    if (planned.kv.type === 'refresh-feature' && planned.kv.feature === 'todos') {
        tasks.push(() => params.invalidate.todos?.() ?? Promise.resolve());
    }

    if (planned.kv.type === 'bulk-keys' && planned.kv.feature === 'todos') {
        const keys = planned.kv.keys;
        tasks.push(async () => {
            const todoKeys = keys.filter((key: string) => key.startsWith('todo.'));
            if (todoKeys.length === 0) {
                return;
            }

            try {
                const bulk = await params.kvBulkGet(params.credentials, todoKeys);
                if (bulk.values.length !== todoKeys.length) {
                    await (params.invalidate.todos?.() ?? Promise.resolve());
                    return;
                }
                await params.applyTodoSocketUpdates(bulk.values.map((value): TodoSocketUpdate => ({ key: value.key, value: value.value, version: value.version })));
            } catch {
                await (params.invalidate.todos?.() ?? Promise.resolve());
            }
        });
    }

    await runTasksWithLimit(tasks, concurrencyLimit);

    let safeAdvanceCursor: string | null = null;
    let processedChanges = 0;

    for (const change of planned.changes) {
        const classification = classifyChangeForCheckpoint(change, {
            isSessionMessagesLoaded: params.isSessionMessagesLoaded,
        });

        if (classification.decision === 'unsupported') {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: classification.blockedReason ?? 'unsupported-kind',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        if (classification.materializationProof === 'project-account-rows') {
            if (!getChangeProjectAccountRowHint(change) || !completedProjectAccountRowKeys.has(change.entityId)) {
                return { status: 'partial', safeAdvanceCursor, blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization', processedChanges,
                    blockedChanges: planned.changes.length - processedChanges };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }

        if (classification.materializationProof === 'authoring-memory') {
            const hint = getChangeAuthoringMemoryHint(change);
            if (!hint || !completedAuthoringMemoryKeys.has(hint.key)) {
                return { status: 'partial', safeAdvanceCursor, blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization', processedChanges,
                    blockedChanges: planned.changes.length - processedChanges };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }

        if (classification.materializationProof === 'workflow-run') {
            const runId = classification.entityId.startsWith('workflow-run:')
                ? classification.entityId.slice('workflow-run:'.length)
                : '';
            if (!runId || !completedWorkflowRunIds.has(runId) || failedWorkflowRunIds.has(runId)) {
                return {
                    status: 'partial',
                    safeAdvanceCursor,
                    blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization',
                    processedChanges,
                    blockedChanges: planned.changes.length - processedChanges,
                };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }


        if (classification.materializationProof === 'session-draft') {
            const hint = getChangeSessionDraftHint(change);
            const key = hint ? canonicalSessionDraftAddressV2(hint.address) : '';
            if (!key || !completedSessionDraftAddresses.has(key) || failedSessionDraftAddresses.has(key)) {
                return {
                    status: 'partial',
                    safeAdvanceCursor,
                    blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization',
                    processedChanges,
                    blockedChanges: planned.changes.length - processedChanges,
                };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }

        if (
            sessionsInvalidationFailed
            && (classification.kind === 'session' || classification.kind === 'share' || classification.materializationProof === 'sessions')
        ) {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: 'partial-materialization',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        if (petsInvalidationFailed && classification.kind === 'pet') {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: 'partial-materialization',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        if (savedSecretResourcesInvalidationFailed && changeRequiresSavedSecretCatalogRefresh(change)) {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: 'partial-materialization',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        if (machinePoolsInvalidationFailed && classification.kind === 'machinePool') {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: 'partial-materialization',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        if (classification.materializationProof === 'session-folder-assignment-refresh') {
            if (sessionFolderAssignmentsInvalidationFailed) {
                return {
                    status: 'partial',
                    safeAdvanceCursor,
                    blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization',
                    processedChanges,
                    blockedChanges: planned.changes.length - processedChanges,
                };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }

        if (classification.materializationProof === 'session-organization') {
            if (sessionOrganizationRefreshFailed) {
                return {
                    status: 'partial',
                    safeAdvanceCursor,
                    blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization',
                    processedChanges,
                    blockedChanges: planned.changes.length - processedChanges,
                };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }

        if (classification.materializationProof === 'pending-queue-convergence') {
            if (!completedPendingSessionIds.has(classification.entityId) || failedPendingSessionIds.has(classification.entityId)) {
                return {
                    status: 'partial',
                    safeAdvanceCursor,
                    blockedCursor: classification.cursor,
                    blockedReason: 'pending-not-converged',
                    processedChanges,
                    blockedChanges: planned.changes.length - processedChanges,
                };
            }
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
        }

        if (
            (classification.kind === 'session' || classification.kind === 'share')
            && loadedCatchUpSessionIdSet.has(classification.entityId)
            && (!completedMessageCatchUpSessionIds.has(classification.entityId) || failedMessageCatchUpSessionIds.has(classification.entityId))
        ) {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: 'partial-materialization',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        const updatedMessage = readSessionUpdatedMessageChangeHintV1(change);
        if (
            updatedMessage
            && params.isSessionMessagesLoaded(classification.entityId)
            && (
                !completedTranscriptRepairSessionIds.has(classification.entityId)
                || failedTranscriptRepairSessionIds.has(classification.entityId)
            )
        ) {
            return {
                status: 'partial',
                safeAdvanceCursor,
                blockedCursor: classification.cursor,
                blockedReason: 'partial-materialization',
                processedChanges,
                blockedChanges: planned.changes.length - processedChanges,
            };
        }

        if (
            (classification.kind === 'session' || classification.kind === 'share')
            && loadedCatchUpSessionIdSet.has(classification.entityId)
        ) {
            const targetSeq = getChangeTargetMessageSeq(change);
            const materializedSeq = params.getSessionMaterializedMaxSeq?.(classification.entityId) ?? null;
            if (
                targetSeq !== null
                && (materializedSeq === null || materializedSeq < targetSeq)
                && params.isSessionMessagesDeferred?.(classification.entityId) !== true
            ) {
                return {
                    status: 'partial',
                    safeAdvanceCursor,
                    blockedCursor: classification.cursor,
                    blockedReason: 'partial-materialization',
                    processedChanges,
                    blockedChanges: planned.changes.length - processedChanges,
                };
            }
        }

        safeAdvanceCursor = classification.cursor;
        processedChanges += 1;
    }

    return {
        status: 'complete',
        safeAdvanceCursor,
        processedChanges,
        blockedChanges: 0,
    };
}
