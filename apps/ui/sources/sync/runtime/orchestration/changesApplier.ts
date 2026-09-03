import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    classifyChangeForCheckpoint,
    getChangeSessionDraftHint,
    getChangeTargetMessageSeq,
    getChangeUpdatedMessageHint,
    type ChangeCheckpointBlockedReason,
    type PlannedChangeActions,
} from './changesPlanner';
import { canonicalSessionDraftAddressV1, type SessionDraftAddressV1 } from '@happier-dev/protocol';
import { runTasksWithLimit } from './runTasksWithLimit';

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
    concurrencyLimit?: number;
    invalidate: {
        settings?: () => Promise<void>;
        profile?: () => Promise<void>;
        machines?: () => Promise<void>;
        artifacts?: () => Promise<void>;
        friends?: () => Promise<void>;
        friendRequests?: () => Promise<void>;
        feed?: () => Promise<void>;
        automations?: () => Promise<void>;
        pets?: () => Promise<void>;
        sessions?: (context: SessionListInvalidationContext) => Promise<void>;
        todos?: () => Promise<void>;
    };
    refreshSessionFolderAssignments?: (plan: Exclude<PlannedChangeActions['sessionFolderAssignments'], { mode: 'none' }>) => Promise<void>;
    refreshSessionOrganization?: (plan: Exclude<PlannedChangeActions['sessionOrganization'], { mode: 'none' }>) => Promise<void>;
    invalidateMessagesForSession: (sessionId: string) => Promise<void>;
    repairSessionTranscriptRevision?: (repair: PlannedChangeActions['sessionTranscriptRepairs'][number]) => Promise<void>;
    invalidateScmStatusForSession: (sessionId: string) => void;
    applyTodoSocketUpdates: (changes: TodoSocketUpdate[]) => Promise<void>;
    kvBulkGet: (credentials: AuthCredentials, keys: string[]) => Promise<{ values: TodoSocketUpdate[] }>;
    convergePendingForSession?: (sessionId: string) => Promise<void>;
    materializeSessionDraft?: (address: SessionDraftAddressV1) => Promise<void>;
}): Promise<PlannedChangesApplyResult> {
    const { planned } = params;

    const concurrencyLimit = typeof params.concurrencyLimit === 'number' && params.concurrencyLimit > 0
        ? Math.trunc(params.concurrencyLimit)
        : 2;

    const tasks: Array<() => Promise<void>> = [];
    const completedMessageCatchUpSessionIds = new Set<string>();
    const failedMessageCatchUpSessionIds = new Set<string>();
    const completedTranscriptRepairSessionIds = new Set<string>();
    const failedTranscriptRepairSessionIds = new Set<string>();
    const completedPendingSessionIds = new Set<string>();
    const failedPendingSessionIds = new Set<string>();
    const completedSessionDraftAddresses = new Set<string>();
    const failedSessionDraftAddresses = new Set<string>();
    let sessionFolderAssignmentsRefreshFailed = false;
    let sessionOrganizationRefreshFailed = false;
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
    const changedSessionIds = planned.sessionIdsToCatchUp;
    const sessionListInvalidationContext: SessionListInvalidationContext = {
        requiredHydrationSessionIds: changedSessionIds,
        prioritizeSessionIds: changedSessionIds,
    };

    let sessionsInvalidationFailed = false;
    let sessionsInvalidationDone: Promise<boolean> | null = null;
    let resolveSessionsInvalidationDone: ((succeeded: boolean) => void) | null = null;
    if (planned.invalidate.sessions) {
        sessionsInvalidationDone = new Promise<boolean>((resolve) => {
            resolveSessionsInvalidationDone = resolve;
        });
    }

    if (planned.invalidate.settings) tasks.push(() => params.invalidate.settings?.() ?? Promise.resolve());
    if (planned.invalidate.profile) tasks.push(() => params.invalidate.profile?.() ?? Promise.resolve());
    if (planned.invalidate.machines) tasks.push(() => params.invalidate.machines?.() ?? Promise.resolve());
    if (planned.invalidate.artifacts) tasks.push(() => params.invalidate.artifacts?.() ?? Promise.resolve());
    if (planned.invalidate.friends) {
        tasks.push(() => params.invalidate.friends?.() ?? Promise.resolve());
        tasks.push(() => params.invalidate.friendRequests?.() ?? Promise.resolve());
    }
    if (planned.invalidate.feed) tasks.push(() => params.invalidate.feed?.() ?? Promise.resolve());
    if (planned.invalidate.automations) tasks.push(() => params.invalidate.automations?.() ?? Promise.resolve());
    if (planned.invalidate.pets) tasks.push(() => params.invalidate.pets?.() ?? Promise.resolve());
    if (planned.invalidate.sessions) {
        tasks.push(async () => {
            try {
                await params.invalidate.sessions?.(sessionListInvalidationContext);
                resolveSessionsInvalidationDone?.(true);
            } catch {
                sessionsInvalidationFailed = true;
                resolveSessionsInvalidationDone?.(false);
            }
        });
    }

    const sessionFolderAssignmentsPlan = planned.sessionFolderAssignments.mode === 'none'
        ? null
        : planned.sessionFolderAssignments;
    if (sessionFolderAssignmentsPlan) {
        tasks.push(async () => {
            try {
                if (!params.refreshSessionFolderAssignments) {
                    sessionFolderAssignmentsRefreshFailed = true;
                    return;
                }
                await params.refreshSessionFolderAssignments(sessionFolderAssignmentsPlan);
            } catch {
                sessionFolderAssignmentsRefreshFailed = true;
            }
        });
    }

    const sessionOrganizationPlan = planned.sessionOrganization.mode === 'none'
        ? null
        : planned.sessionOrganization;
    if (sessionOrganizationPlan) {
        tasks.push(async () => {
            try {
                if (!params.refreshSessionOrganization) {
                    sessionOrganizationRefreshFailed = true;
                    return;
                }
                await params.refreshSessionOrganization(sessionOrganizationPlan);
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

    for (const address of planned.sessionDraftAddresses) {
        tasks.push(async () => {
            const key = canonicalSessionDraftAddressV1(address);
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

        if (
            sessionsInvalidationFailed
            && (classification.kind === 'session' || classification.kind === 'share')
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


        if (classification.materializationProof === 'session-draft') {
            const hint = getChangeSessionDraftHint(change);
            const key = hint ? canonicalSessionDraftAddressV1(hint.address) : '';
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

        if (classification.materializationProof === 'session-folder-assignments') {
            if (sessionFolderAssignmentsRefreshFailed) {
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

        const updatedMessage = getChangeUpdatedMessageHint(change);
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
            if (targetSeq !== null && (materializedSeq === null || materializedSeq < targetSeq)) {
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
