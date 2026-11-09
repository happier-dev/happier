import { isNotificationQuestionAnswerAction, readNotificationQuestionAnswer } from '@happier-dev/protocol/push/notificationQuestionActions';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { GuardStopWarningPushDataV1Schema, WorkflowRunUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';

import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { coerceRelativeRoute } from '@/utils/path/routeUtils';

import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';

import type { ActivityWorkflowRunTarget, ParsedActivityInteraction } from './activityActionTypes';
import { createActivitySurfaceSessionRoute, parseActivitySurfaceSessionTarget } from './activitySurfaceTargets';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSessionId(data: unknown): string {
    if (!isRecord(data)) return '';
    return typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
}

function readPrimarySessionId(data: unknown): string {
    if (!isRecord(data)) return '';
    return typeof data.primarySessionId === 'string' ? data.primarySessionId.trim() : '';
}

function readRequestId(data: unknown): string {
    if (!isRecord(data)) return '';
    if (typeof data.requestId === 'string') return data.requestId.trim();
    if (typeof data.permissionId === 'string') return data.permissionId.trim();
    return '';
}

function readTurnId(data: unknown): string {
    if (!isRecord(data)) return '';
    return typeof data.turnId === 'string' ? data.turnId.trim() : '';
}

function readServerId(data: unknown): string | null {
    if (!isRecord(data)) return null;
    const serverId = typeof data.serverId === 'string' ? data.serverId.trim() : '';
    return serverId || null;
}

/**
 * The workflow Run a `workflow_run_update` notification points at.
 *
 * The four workflow fields are validated as a whole by the canonical
 * notification schema, so the exact topic, the Run id contract and the closed
 * update-kind vocabulary are all enforced by their owner. Only those fields are
 * projected into it: the schema is strict, while real push data also carries
 * the server routing the notification owner injects.
 *
 * A foreign topic, a malformed id or an update kind outside the closed set
 * fails closed and produces no navigation.
 */
function readWorkflowRunTarget(data: unknown): ActivityWorkflowRunTarget | null {
    if (!isRecord(data)) return null;
    const parsed = WorkflowRunUpdateNotificationV1Schema.safeParse({
        topic: data.topic,
        runId: data.runId,
        updateKind: data.updateKind,
        ...(data.reason === undefined ? {} : { reason: data.reason }),
    });
    return parsed.success ? { runId: parsed.data.runId } : null;
}

function resolveRoute(data: unknown): string | null {
    if (!isRecord(data)) return null;
    if (typeof data.url === 'string' && data.url.trim()) {
        return coerceRelativeRoute(data.url);
    }
    const sessionId = readSessionId(data);
    return sessionId ? createActivitySurfaceSessionRoute(sessionId, readServerId(data)) : null;
}

function resolveServerUrl(data: unknown): string | null {
    if (!isRecord(data)) return null;
    const raw =
        typeof data.serverUrl === 'string'
            ? data.serverUrl
            : typeof data.server === 'string'
                ? data.server
                : '';
    const normalized = normalizeServerUrl(raw);
    return normalized ? normalized : null;
}

function resolveActivitySurfaceRoute(actionIdentifier: string, data: unknown): string | null {
    if (actionIdentifier === 'open-inbox') {
        return '/inbox';
    }

    if (actionIdentifier === 'open-primary-session') {
        const primarySessionId = readPrimarySessionId(data) || readSessionId(data);
        return primarySessionId ? createActivitySurfaceSessionRoute(primarySessionId, readServerId(data)) : '/inbox';
    }

    if (actionIdentifier.startsWith('open-session:')) {
        const targetIdentity = parseActivitySurfaceSessionTarget(actionIdentifier);
        return targetIdentity
            ? createActivitySurfaceSessionRoute(targetIdentity.sessionId, targetIdentity.serverId ?? readServerId(data))
            : null;
    }

    return null;
}

export function parseActivityInteraction(params: Readonly<{
    actionIdentifier: string;
    defaultActionIdentifier: string;
    data: unknown;
    userText?: unknown;
}>): ParsedActivityInteraction | null {
    const actionIdentifier = params.actionIdentifier.trim() || params.defaultActionIdentifier;
    const isDefaultTap = actionIdentifier === params.defaultActionIdentifier;
    if (isRecord(params.data) && params.data.topic === 'guard_stop_warning') {
        const warning = GuardStopWarningPushDataV1Schema.safeParse(params.data);
        if (!warning.success) return null;
        const guardAction = actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1 ? 'keepRunning'
            : actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1 ? 'stopNow' : undefined;
        if (!isDefaultTap && !guardAction) return null;
        return { actionIdentifier, isDefaultTap, isOpenAction: isDefaultTap, route: resolveRoute(params.data),
            serverUrl: resolveServerUrl(params.data), permissionAction: null, workflowRun: null,
            ...(guardAction ? { guardAction } : {}) };
    }
    const permissionAction =
        actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1
            ? ('allow' as const)
            : actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1
                ? ('deny' as const)
                : null;
    const activitySurfaceRoute = resolveActivitySurfaceRoute(actionIdentifier, params.data);

    const workflowRun = readWorkflowRunTarget(params.data);
    const isQuestionAction = isNotificationQuestionAnswerAction(actionIdentifier);
    const answers = isQuestionAction && isRecord(params.data)
        ? readNotificationQuestionAnswer(params.data.questionAnswerV1, actionIdentifier, params.userText) : null;
    const isOpenAction =
        isDefaultTap
        || isQuestionAction && !answers
        || actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1
        || activitySurfaceRoute !== null
        || workflowRun !== null;
    if (!isOpenAction && permissionAction === null && !isQuestionAction) {
        return null;
    }

    const sessionId = readSessionId(params.data);
    const requestId = readRequestId(params.data);
    const turnId = readTurnId(params.data);
    const accountId = isRecord(params.data) && typeof params.data.accountId === 'string' ? params.data.accountId.trim() : '';
    const questionAction = answers && sessionId && requestId && turnId && accountId
        ? { sessionId, requestId, turnId, answers } : null;
    // A workflow Run is addressed by identity, so its route is derived here and
    // deliberately takes precedence over any `url` the payload carries.
    const route = workflowRun
        ? createWorkflowRunRoute(workflowRun.runId, readServerId(params.data))
        : activitySurfaceRoute ?? resolveRoute(params.data);
    const resolvedPermissionAction =
        permissionAction && sessionId && requestId
            ? {
                action: permissionAction,
                sessionId,
                requestId,
                ...(turnId ? { turnId } : {}),
            }
            : null;

    if (!route && resolvedPermissionAction === null) {
        return null;
    }

    return {
        actionIdentifier,
        isDefaultTap,
        isOpenAction: isOpenAction || isQuestionAction && !questionAction,
        route,
        serverUrl: resolveServerUrl(params.data),
        permissionAction: resolvedPermissionAction,
        ...(isQuestionAction ? { questionAction } : {}),
        workflowRun,
    };
}
