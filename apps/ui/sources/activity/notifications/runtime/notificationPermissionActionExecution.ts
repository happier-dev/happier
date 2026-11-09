import { isNotificationQuestionAnswerAction } from '@happier-dev/protocol/push/notificationQuestionActions';
import { buildSessionUserActionAnswerMap } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { parseNotificationTap, type ParsedNotificationTap } from '../notificationRouting';
import { resolveNotificationSavedHome } from '../resolveNotificationSavedHome';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { isNotificationExecutionAction, markNotificationResponseHandled,
    type NotificationPermissionOutcome, type NotificationPermissionActionOptions, type NotificationPermissionActionContext } from './notificationPermissionActions';

const responses = new Map<string, { action: string; promise: Promise<NotificationPermissionOutcome> }>();
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Loaded execution graph. The public notification entry owns the whole lifetime. */
export async function executeNotificationPermissionAction(parsed: ParsedNotificationTap,
    options: NotificationPermissionActionOptions, context: NotificationPermissionActionContext,
): Promise<NotificationPermissionOutcome> {
    if (!isNotificationExecutionAction(parsed)) return { status: 'ignored' };
    if (options.allowExecution === false || context.signal.aborted) return { status: 'not_sent' };
    markNotificationResponseHandled(parsed);
    const command = parsed.command;
    if (command.kind !== 'executeAction' || !isRecord(command.payload)) return { status: 'not_sent' };
    const question = command.actionId === 'session.user_action.answer';
    if (!question && command.actionId !== 'session.permission.respond') return { status: 'not_sent' };
    const { sessionId, requestId, turnId, decision } = command.payload;
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof requestId !== 'string' || !requestId.trim()
        || typeof turnId !== 'string' || !turnId.trim()) return { status: 'not_sent' };
    const answers = question ? buildSessionUserActionAnswerMap(command.payload.answers) : null;
    if (question ? !parsed.accountId?.trim() || !answers || Object.keys(answers).length === 0
        : decision !== 'allow' && decision !== 'deny') return { status: 'not_sent' };
    const serverUrl = command.target.serverUrl;
    if (!serverUrl) return { status: 'not_sent' };
    const home = resolveNotificationSavedHome({ serverId: command.target.serverId, serverUrl });
    if (!home || context.signal.aborted) return { status: 'not_sent' };
    const identifiedServerId = resolveServerProfileScopeIdForIdentifier(home.id);
    const expected = parsed.accountId && identifiedServerId ? createServerAccountScope(identifiedServerId, parsed.accountId) : null;
    if (expected) context.onTargetResolved(expected);
    const binding = await resolveServerCredentialAccountScope(home.id);
    if (binding.kind !== 'bound' || context.signal.aborted
        || parsed.accountId && parsed.accountId !== binding.scope.accountId) return { status: 'not_sent' };
    context.onTargetResolved(binding.scope);
    const key = JSON.stringify([binding.scope.serverId, binding.scope.accountId, sessionId, turnId, requestId,
        question ? 'question' : 'permission']);
    const action = question ? JSON.stringify(Object.entries(answers!).sort(([a], [b]) => a.localeCompare(b))) : String(decision);
    const pending = responses.get(key);
    if (pending) return pending.action === action ? pending.promise : { status: 'conflict' };
    const send = (async (): Promise<NotificationPermissionOutcome> => {
        let issued = false;
        let finished = false;
        let rejectAborted: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
            rejectAborted = () => reject(new Error('Notification response ended'));
            context.signal.addEventListener('abort', rejectAborted, { once: true });
        });
        const onIssued = () => {
            if (finished || context.signal.aborted) throw new Error('Notification response ended');
            issued = true; context.onIssued();
        };
        try {
            await Promise.race([(async () => {
            const { sessionRespondToPermissionWithServerAccountScope, sessionRespondToUserAction } = await import('@/sync/ops/sessions');
            if (context.signal.aborted) throw new Error('Notification response ended');
            const target = { scope: binding.scope, networkMode: 'background-task' as const, signal: context.signal, onIssued };
            if (question) {
                await sessionRespondToUserAction(sessionId, { id: requestId, turnId, approved: true, answers: answers! }, target);
            } else {
                await sessionRespondToPermissionWithServerAccountScope(sessionId, { id: requestId, turnId,
                    approved: decision === 'allow', decision: decision === 'allow' ? 'approved' : 'denied' }, target);
            }
            })(), aborted]);
            return { status: issued ? 'confirmed' : 'not_sent' };
        } catch (error) {
            return { status: !issued ? 'not_sent' : readRpcErrorCode(error)?.startsWith('permission_') ? 'rejected' : 'unconfirmed' };
        } finally {
            finished = true;
            if (rejectAborted) context.signal.removeEventListener('abort', rejectAborted);
        }
    })();
    responses.set(key, { action, promise: send });
    void send.then(outcome => {
        if (outcome.status !== 'confirmed' && responses.get(key)?.promise === send) responses.delete(key);
    });
    return send;
}
export async function handleNotificationBackgroundTask(body: unknown,
    options: NotificationPermissionActionOptions, context: NotificationPermissionActionContext,
): Promise<NotificationPermissionOutcome> {
    if (!isRecord(body) || !('data' in body)) return { status: 'ignored' };
    if (body.error) return { status: 'not_sent' };
    if (!isRecord(body.data) || !('actionIdentifier' in body.data)) return { status: 'ignored' };
    const parsed = parseNotificationTap({ response: body.data, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
    if (parsed && isNotificationQuestionAnswerAction(parsed.actionIdentifier ?? '') && !isNotificationExecutionAction(parsed)) return { status: 'not_sent' };
    return parsed ? executeNotificationPermissionAction(parsed, options, context) : { status: 'ignored' };
}
