import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    classifyChangeForCheckpoint,
    getChangeTargetMessageSeq,
    type ChangeCheckpointBlockedReason,
    type PlannedChangeActions,
} from './changesPlanner';
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

export async function applyPlannedChangeActions(params: {
    planned: PlannedChangeActions;
    credentials: AuthCredentials;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
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
        sessions?: () => Promise<void>;
        todos?: () => Promise<void>;
    };
    invalidateMessagesForSession: (sessionId: string) => Promise<void>;
    invalidateScmStatusForSession: (sessionId: string) => void;
    applyTodoSocketUpdates: (changes: TodoSocketUpdate[]) => Promise<void>;
    kvBulkGet: (credentials: AuthCredentials, keys: string[]) => Promise<{ values: TodoSocketUpdate[] }>;
    convergePendingForSession?: (sessionId: string) => Promise<void>;
}): Promise<PlannedChangesApplyResult> {
    const { planned } = params;

    const concurrencyLimit = typeof params.concurrencyLimit === 'number' && params.concurrencyLimit > 0
        ? Math.trunc(params.concurrencyLimit)
        : 2;

    const tasks: Array<() => Promise<void>> = [];
    const completedMessageCatchUpSessionIds = new Set<string>();
    const failedMessageCatchUpSessionIds = new Set<string>();
    const completedPendingSessionIds = new Set<string>();
    const failedPendingSessionIds = new Set<string>();

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
                await params.invalidate.sessions?.();
                resolveSessionsInvalidationDone?.(true);
            } catch {
                sessionsInvalidationFailed = true;
                resolveSessionsInvalidationDone?.(false);
            }
        });
    }

    for (const sessionId of planned.sessionIdsToCatchUp) {
        if (!params.isSessionMessagesLoaded(sessionId)) {
            continue;
        }
        tasks.push(async () => {
            try {
                if (sessionsInvalidationDone) {
                    const sessionsInvalidated = await sessionsInvalidationDone;
                    if (!sessionsInvalidated) {
                        failedMessageCatchUpSessionIds.add(sessionId);
                        return;
                    }
                }
                await params.invalidateMessagesForSession(sessionId);
                completedMessageCatchUpSessionIds.add(sessionId);
            } catch {
                failedMessageCatchUpSessionIds.add(sessionId);
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

        if (classification.decision === 'intentionally-skipped-by-explicit-policy') {
            safeAdvanceCursor = classification.cursor;
            processedChanges += 1;
            continue;
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

        if (
            (classification.kind === 'session' || classification.kind === 'share')
            && params.isSessionMessagesLoaded(classification.entityId)
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

        if (
            (classification.kind === 'session' || classification.kind === 'share')
            && params.isSessionMessagesLoaded(classification.entityId)
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
