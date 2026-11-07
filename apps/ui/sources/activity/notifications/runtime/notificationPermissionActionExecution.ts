import { isNotificationExecutionAction, parseNotificationTap, type ParsedNotificationTap } from '../notificationRouting';
import { createNotificationPermissionCoordinator, type NotificationPermissionOutcome } from './notificationPermissionCoordinator';
import { markNotificationResponseHandled } from './notificationResponseConsumption';
import type { NotificationPermissionActionContext, NotificationPermissionActionOptions } from './notificationPermissionActions';
import { isNotificationQuestionAnswerAction } from '@happier-dev/protocol';
import { getAppLockSnapshot, loadAppLock, subscribeAppLock } from '@/auth/appLock/appLockRuntime';

const coordinate = createNotificationPermissionCoordinator();

/** Loaded execution graph; the public entry owns this operation's lifetime. */
export async function executeNotificationPermissionAction(
    parsed: ParsedNotificationTap,
    options: NotificationPermissionActionOptions,
    context: NotificationPermissionActionContext,
): Promise<NotificationPermissionOutcome> {
    if (!isNotificationExecutionAction(parsed)) return { status: 'ignored' };
    // Cached notification delivery is observation, never authorization to send.
    if (options.allowExecution === false) return { status: 'not_sent' };
    await loadAppLock();
    if (getAppLockSnapshot().status === 'locked') return { status: 'not_sent' };
    const lifetime = new AbortController();
    const abort = () => lifetime.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const stopWatchingLock = subscribeAppLock(() => {
        if (getAppLockSnapshot().status === 'locked') abort();
    });
    try {
        markNotificationResponseHandled(parsed);
        if (parsed.questionAction && !parsed.accountId?.trim()) return { status: 'not_sent' };
        const response = parsed.questionAction ?? parsed.permissionAction;
        if (!response?.occurrenceId || !parsed.serverUrl) return { status: 'not_sent' };
        const { sessionId, requestId, occurrenceId } = response;
        const action = parsed.questionAction ? { answers: parsed.questionAction.answers } : parsed.permissionAction!.action;
        const serverUrl = parsed.serverUrl;
        if (!sessionId.trim() || !requestId.trim() || context.signal.aborted) return { status: 'not_sent' };

        const { resolveNotificationPermissionTarget } = await (options.importTarget ?? (() => import('./resolveNotificationPermissionTarget')))();
        if (context.signal.aborted) return { status: 'not_sent' };
        const scope = await resolveNotificationPermissionTarget(serverUrl, parsed.accountId, { onTargetIdentified: context.onTargetResolved });
        if (!scope || lifetime.signal.aborted) return { status: 'not_sent' };
        context.onTargetResolved(scope);
        return await coordinate({ ...scope, sessionId, requestId, occurrenceId, action }, async (onIssued, signal) => {
            const issued = () => {
                if (signal.aborted || getAppLockSnapshot().status === 'locked') throw new Error('App is locked');
                onIssued(); context.onIssued();
            };
            if (typeof action !== 'string') {
                const { sessionRespondToStructuredQuestion } = await import('@/sync/ops/sessionStructuredQuestion');
                if (getAppLockSnapshot().status === 'locked') return { ok: false, error: 'app_locked' };
                return sessionRespondToStructuredQuestion({
                    sessionId, request: { id: requestId, occurrenceId, structuredAnswersV1: action.answers },
                    target: { scope }, networkMode: 'background-task', signal, onIssued: issued,
                });
            }
            const { sessionPermissionDecisionWithServerAccountScope } = await import('@/sync/ops/sessionPermissionDecision');
            if (getAppLockSnapshot().status === 'locked') return { ok: false, error: 'app_locked' };
            return sessionPermissionDecisionWithServerAccountScope({
                scope, sessionId, requestId, occurrenceId, action,
                networkMode: 'background-task',
                signal,
                onIssued: issued,
            });
        }, { signal: lifetime.signal });
    } finally {
        stopWatchingLock();
        context.signal.removeEventListener('abort', abort);
        lifetime.abort();
    }
}

export async function handleNotificationBackgroundTask(
    body: unknown,
    options: NotificationPermissionActionOptions,
    context: NotificationPermissionActionContext,
): Promise<NotificationPermissionOutcome> {
    if (typeof body !== 'object' || body === null || !('data' in body)) return { status: 'ignored' };
    if ('error' in body && body.error) return { status: 'not_sent' };
    const data = body.data;
    if (typeof data !== 'object' || data === null || !('actionIdentifier' in data)) return { status: 'ignored' };
    const parsed = parseNotificationTap({ response: data, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
    if (parsed && isNotificationQuestionAnswerAction(parsed.actionIdentifier) && !parsed.questionAction) {
        return { status: 'not_sent' };
    }
    return parsed ? executeNotificationPermissionAction(parsed, options, context) : { status: 'ignored' };
}
