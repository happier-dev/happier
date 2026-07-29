import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { resolveSessionListItemOrganizationEligibility } from '@/sync/domains/sessionList/sessionListIndex';

import {
    createSessionBulkActionProgressTracker,
} from './sessionBulkActionProgress';
import {
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionExecutionContext,
    type SessionBulkActionExecutionResult,
    type SessionBulkActionId,
    type SessionBulkActionRequest,
    type SessionBulkActionTarget,
    type SessionBulkActionTargetResult,
    type SessionBulkMutationResult,
    type SessionBulkReadState,
    type SessionBulkServerGroup,
} from './sessionBulkActionTypes';

export {
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionCancelSignal,
    type SessionBulkActionExecutionContext,
    type SessionBulkActionExecutionResult,
    type SessionBulkActionId,
    type SessionBulkActionProgressSnapshot,
    type SessionBulkActionRequest,
    type SessionBulkActionTarget,
    type SessionBulkActionTargetResult,
    type SessionBulkMutationResult,
    type SessionBulkReadState,
    type SessionBulkServerGroup,
} from './sessionBulkActionTypes';

const DEFAULT_CONCURRENCY_LIMIT = 4;
const DEFAULT_STOP_ERROR_MESSAGE = 'Failed to stop session';
const DEFAULT_ARCHIVE_ERROR_MESSAGE = 'Failed to archive session';

function normalizeConcurrencyLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONCURRENCY_LIMIT;
    return Math.max(1, Math.trunc(value));
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of tags ?? []) {
        const normalized = String(tag).trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function createTargetResult(
    target: SessionBulkActionTarget,
    status: SessionBulkActionTargetResult['status'],
    params?: Readonly<{ reasonCode?: string; reason?: string }>,
): SessionBulkActionTargetResult {
    return {
        target,
        status,
        reasonCode: params?.reasonCode,
        reason: params?.reason,
    };
}

function reasonFromUnknown(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return fallback;
}

function resultFromMutation(
    target: SessionBulkActionTarget,
    mutation: SessionBulkMutationResult,
    fallback: string,
): SessionBulkActionTargetResult {
    if (mutation.success) return createTargetResult(target, 'succeeded');
    return createTargetResult(target, 'failed', {
        reasonCode: mutation.code,
        reason: mutation.message || fallback,
    });
}

function buildExecutionResult(params: Readonly<{
    actionId: SessionBulkActionId;
    targetCount: number;
    results: readonly SessionBulkActionTargetResult[];
    progress: SessionBulkActionExecutionResult['progress'];
}>): SessionBulkActionExecutionResult {
    const succeeded = params.results.filter((entry) => entry.status === 'succeeded');
    const failed = params.results.filter((entry) => entry.status === 'failed');
    const skipped = params.results.filter((entry) => entry.status === 'skipped');
    const cancelled = params.results.filter((entry) => entry.status === 'cancelled');
    const remainingSelectedKeys = [...failed, ...skipped, ...cancelled].map((entry) => entry.target.key);

    return {
        actionId: params.actionId,
        targetCount: params.targetCount,
        results: params.results,
        succeeded,
        failed,
        skipped,
        cancelled,
        remainingSelectedKeys,
        progress: params.progress,
    };
}

function buildEmptyExecutionResult(actionId: SessionBulkActionId): SessionBulkActionExecutionResult {
    const tracker = createSessionBulkActionProgressTracker({ total: 0 });
    return buildExecutionResult({
        actionId,
        targetCount: 0,
        results: [],
        progress: tracker.snapshot(),
    });
}

export function groupSessionBulkTargetsByServer(
    targets: readonly SessionBulkActionTarget[],
): SessionBulkServerGroup[] {
    const groups: SessionBulkServerGroup[] = [];
    const indexByServerId = new Map<string, number>();

    for (const target of targets) {
        const serverId = target.serverId ?? null;
        const key = serverId ?? '__local__';
        const existingIndex = indexByServerId.get(key);
        if (existingIndex !== undefined) {
            const existing = groups[existingIndex];
            groups[existingIndex] = {
                serverId: existing.serverId,
                targets: [...existing.targets, target],
            };
            continue;
        }

        indexByServerId.set(key, groups.length);
        groups.push({ serverId, targets: [target] });
    }

    return groups;
}

function flattenByServerGroup(targets: readonly SessionBulkActionTarget[]): SessionBulkActionTarget[] {
    return groupSessionBulkTargetsByServer(targets).flatMap((group) => group.targets);
}

async function executeNetworkTargets(params: Readonly<{
    actionId: SessionBulkActionId;
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
    runTarget: (target: SessionBulkActionTarget) => Promise<SessionBulkActionTargetResult>;
}>): Promise<SessionBulkActionExecutionResult> {
    const orderedTargets = flattenByServerGroup(params.targets);
    const tracker = createSessionBulkActionProgressTracker({
        total: orderedTargets.length,
        onProgress: params.context.onProgress,
    });

    const tasks = orderedTargets.map((target) => async (): Promise<SessionBulkActionTargetResult> => {
        if (params.context.cancelSignal?.isCancelled()) {
            tracker.cancel();
            return createTargetResult(target, 'cancelled', {
                reasonCode: 'cancelled',
                reason: 'Cancelled',
            });
        }

        tracker.start();
        try {
            const result = await params.runTarget(target);
            if (result.status === 'succeeded') {
                tracker.succeed();
            } else if (result.status === 'skipped') {
                tracker.skip();
            } else if (result.status === 'cancelled') {
                tracker.cancel();
            } else {
                tracker.fail();
            }
            return result;
        } catch (error) {
            tracker.fail();
            return createTargetResult(target, 'failed', {
                reason: reasonFromUnknown(error, 'Action failed'),
            });
        }
    });

    const results = await runTasksWithLimit(tasks, normalizeConcurrencyLimit(params.context.concurrencyLimit));

    return buildExecutionResult({
        actionId: params.actionId,
        targetCount: orderedTargets.length,
        results,
        progress: tracker.snapshot(),
    });
}

function requireOperation<T>(
    operation: T | undefined,
    name: string,
): T {
    if (!operation) {
        throw new Error(`${name} is required`);
    }
    return operation;
}

async function executePinAction(params: Readonly<{
    actionId: typeof SESSION_BULK_ACTION_IDS.pin | typeof SESSION_BULK_ACTION_IDS.unpin;
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    const setSessionPin = requireOperation(
        params.context.setSessionPin,
        'setSessionPin',
    );
    const pinned = params.actionId === SESSION_BULK_ACTION_IDS.pin;

    return executeNetworkTargets({
        actionId: params.actionId,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            await setSessionPin({ target, pinned });
            return createTargetResult(target, 'succeeded');
        },
    });
}

async function executeTagAction(params: Readonly<{
    action: Extract<SessionBulkActionRequest, { tags: readonly string[] }>;
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    const setSessionTagAssignments = requireOperation(
        params.context.setSessionTagAssignments,
        'setSessionTagAssignments',
    );
    const actionTags = normalizeTags(params.action.tags);

    return executeNetworkTargets({
        actionId: params.action.id,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            const existing = normalizeTags(target.tags);
            let tags: string[];
            if (params.action.id === SESSION_BULK_ACTION_IDS.tagsAdd) {
                tags = normalizeTags([...existing, ...actionTags]);
            } else if (params.action.id === SESSION_BULK_ACTION_IDS.tagsRemove) {
                const toRemove = new Set(actionTags);
                tags = existing.filter((tag) => !toRemove.has(tag));
            } else {
                tags = actionTags;
            }
            await setSessionTagAssignments({ target, tags });
            return createTargetResult(target, 'succeeded');
        },
    });
}

function skipAll(params: Readonly<{
    actionId: SessionBulkActionId;
    targets: readonly SessionBulkActionTarget[];
    reasonCode: string;
    reason: string;
}>): SessionBulkActionExecutionResult {
    const tracker = createSessionBulkActionProgressTracker({
        total: params.targets.length,
        initiallySkipped: params.targets.length,
    });
    const results = params.targets.map((target) => createTargetResult(target, 'skipped', {
        reasonCode: params.reasonCode,
        reason: params.reason,
    }));
    return buildExecutionResult({
        actionId: params.actionId,
        targetCount: params.targets.length,
        results,
        progress: tracker.snapshot(),
    });
}

function isFoldersFeatureEnabled(context: SessionBulkActionExecutionContext): boolean {
    return context.foldersFeatureDecision?.state === 'enabled';
}

function createPermissionDeniedResult(target: SessionBulkActionTarget): SessionBulkActionTargetResult {
    return createTargetResult(target, 'skipped', {
        reasonCode: 'permission_denied',
        reason: 'You do not have permission to perform this action',
    });
}

async function executeStopAction(params: Readonly<{
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    const stopSession = requireOperation(params.context.stopSession, 'stopSession');
    return executeNetworkTargets({
        actionId: SESSION_BULK_ACTION_IDS.stop,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            if (target.active === false) {
                return createTargetResult(target, 'skipped', {
                    reasonCode: 'session_inactive',
                    reason: 'Session is already inactive',
                });
            }
            if (target.canStop !== true) {
                return createPermissionDeniedResult(target);
            }
            return resultFromMutation(
                target,
                await stopSession(target),
                DEFAULT_STOP_ERROR_MESSAGE,
            );
        },
    });
}

async function executeArchiveAction(params: Readonly<{
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    const archiveSession = requireOperation(params.context.archiveSession, 'archiveSession');
    const stopSession = params.context.stopSession;
    const stopSessionAndMaybeArchive = params.context.stopSessionAndMaybeArchive;

    return executeNetworkTargets({
        actionId: SESSION_BULK_ACTION_IDS.archive,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            if (target.archived === true) {
                return createTargetResult(target, 'skipped', {
                    reasonCode: 'already_archived',
                    reason: 'Session is already archived',
                });
            }
            if (target.canArchive !== true) {
                return createPermissionDeniedResult(target);
            }

            if (target.active === true) {
                if (!stopSession || !stopSessionAndMaybeArchive) {
                    return createTargetResult(target, 'failed', {
                        reasonCode: 'missing_active_archive_adapter',
                        reason: 'Active archive requires stop-and-archive support',
                    });
                }

                await stopSessionAndMaybeArchive({
                    target,
                    sessionId: target.sessionId,
                    hideInactiveSessions: params.context.hideInactiveSessions === true,
                    isPinned: target.pinned === true,
                    archiveAfterStop: 'always',
                    stopSession: () => stopSession(target),
                    archiveSession: () => archiveSession(target),
                    stopErrorMessage: params.context.stopErrorMessage ?? DEFAULT_STOP_ERROR_MESSAGE,
                    archiveErrorMessage: params.context.archiveErrorMessage ?? DEFAULT_ARCHIVE_ERROR_MESSAGE,
                });
                return createTargetResult(target, 'succeeded');
            }

            return resultFromMutation(
                target,
                await archiveSession(target),
                DEFAULT_ARCHIVE_ERROR_MESSAGE,
            );
        },
    });
}

async function executeUnarchiveAction(params: Readonly<{
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    const unarchiveSession = requireOperation(params.context.unarchiveSession, 'unarchiveSession');
    return executeNetworkTargets({
        actionId: SESSION_BULK_ACTION_IDS.unarchive,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            if (target.archived !== true) {
                return createTargetResult(target, 'skipped', {
                    reasonCode: 'not_archived',
                    reason: 'Session is not archived',
                });
            }
            if (target.hasAdminAccess !== true) {
                return createPermissionDeniedResult(target);
            }
            return resultFromMutation(
                target,
                await unarchiveSession(target),
                'Failed to unarchive session',
            );
        },
    });
}

async function executeReadStateAction(params: Readonly<{
    actionId: typeof SESSION_BULK_ACTION_IDS.markRead | typeof SESSION_BULK_ACTION_IDS.markUnread;
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    const setManualReadState = requireOperation(params.context.setManualReadState, 'setManualReadState');
    const readState: SessionBulkReadState = params.actionId === SESSION_BULK_ACTION_IDS.markRead ? 'read' : 'unread';
    return executeNetworkTargets({
        actionId: params.actionId,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            if (target.readState !== 'read' && target.readState !== 'unread') {
                return createTargetResult(target, 'skipped', {
                    reasonCode: 'read_state_unavailable',
                    reason: 'Session read state is unavailable',
                });
            }
            if (target.readState === readState) {
                return createTargetResult(target, 'succeeded');
            }
            return resultFromMutation(
                target,
                await setManualReadState(target, readState),
                'Failed to update session read state',
            );
        },
    });
}

async function executeMoveToFolderAction(params: Readonly<{
    action: Extract<SessionBulkActionRequest, { id: typeof SESSION_BULK_ACTION_IDS.moveToFolder }>;
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    if (!isFoldersFeatureEnabled(params.context)) {
        return skipAll({
            actionId: SESSION_BULK_ACTION_IDS.moveToFolder,
            targets: params.targets,
            reasonCode: 'feature_disabled',
            reason: 'Session folders are disabled',
        });
    }

    if (!params.action.destinationWorkspace) {
        return skipAll({
            actionId: SESSION_BULK_ACTION_IDS.moveToFolder,
            targets: params.targets,
            reasonCode: 'folder_destination_scope_unavailable',
            reason: 'The destination folder scope is unavailable',
        });
    }

    const eligibilityByTarget = new Map(
        params.targets.map((target) => [
            target,
            resolveSessionListItemOrganizationEligibility({
                type: 'session',
                sessionId: target.sessionId,
                serverId: target.serverId ?? undefined,
                workspace: target.workspace ?? undefined,
            }, {
                foldersFeatureEnabled: true,
                destinationWorkspace: params.action.destinationWorkspace,
            }),
        ] as const),
    );

    const setSessionFolderAssignment = requireOperation(
        params.context.setSessionFolderAssignment,
        'setSessionFolderAssignment',
    );

    return executeNetworkTargets({
        actionId: SESSION_BULK_ACTION_IDS.moveToFolder,
        targets: params.targets,
        context: params.context,
        runTarget: async (target) => {
            const eligibility = eligibilityByTarget.get(target);
            if (target.canMoveToFolder !== true || !eligibility?.canUseSessionFolders) {
                const destinationScopeMismatch = eligibility?.reason === 'destination-scope-mismatch';
                return createTargetResult(target, 'skipped', {
                    reasonCode: destinationScopeMismatch
                        ? 'folder_destination_scope_mismatch'
                        : 'folder_move_unavailable',
                    reason: destinationScopeMismatch
                        ? 'Session belongs to a different workspace'
                        : 'Session cannot be moved to this folder',
                });
            }
            await setSessionFolderAssignment({
                target,
                folderId: params.action.folderId,
            });
            return createTargetResult(target, 'succeeded');
        },
    });
}

export async function executeSessionBulkAction(params: Readonly<{
    action: SessionBulkActionRequest;
    targets: readonly SessionBulkActionTarget[];
    context: SessionBulkActionExecutionContext;
}>): Promise<SessionBulkActionExecutionResult> {
    if (params.targets.length === 0) {
        return buildEmptyExecutionResult(params.action.id);
    }

    switch (params.action.id) {
        case SESSION_BULK_ACTION_IDS.pin:
        case SESSION_BULK_ACTION_IDS.unpin:
            return executePinAction({
                actionId: params.action.id,
                targets: params.targets,
                context: params.context,
            });
        case SESSION_BULK_ACTION_IDS.tagsAdd:
        case SESSION_BULK_ACTION_IDS.tagsRemove:
        case SESSION_BULK_ACTION_IDS.tagsSet:
            return executeTagAction({
                action: params.action,
                targets: params.targets,
                context: params.context,
            });
        case SESSION_BULK_ACTION_IDS.stop:
            return executeStopAction({
                targets: params.targets,
                context: params.context,
            });
        case SESSION_BULK_ACTION_IDS.archive:
            return executeArchiveAction({
                targets: params.targets,
                context: params.context,
            });
        case SESSION_BULK_ACTION_IDS.unarchive:
            return executeUnarchiveAction({
                targets: params.targets,
                context: params.context,
            });
        case SESSION_BULK_ACTION_IDS.markRead:
        case SESSION_BULK_ACTION_IDS.markUnread:
            return executeReadStateAction({
                actionId: params.action.id,
                targets: params.targets,
                context: params.context,
            });
        case SESSION_BULK_ACTION_IDS.moveToFolder:
            return executeMoveToFolderAction({
                action: params.action,
                targets: params.targets,
                context: params.context,
            });
        default: {
            const unreachable: never = params.action;
            throw new Error(`Unsupported bulk session action: ${String(unreachable)}`);
        }
    }
}
