import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import type { ParsedNotificationTap } from '../notificationRouting';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { withTimeout } from '@/utils/timing/time';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';

type Execution = typeof import('./notificationPermissionActionExecution');
export type NotificationPermissionOutcome = Readonly<{
    status: 'ignored' | 'not_sent' | 'confirmed' | 'rejected' | 'unconfirmed' | 'conflict';
}>;
export type NotificationPermissionActionOptions = Readonly<{
    allowExecution?: boolean; signal?: AbortSignal;
    // Genuine bundle loading boundary; internal parsing, admission and RPC remain real.
    importExecution?: () => Promise<Execution>;
}>;
export type NotificationPermissionActionContext = Readonly<{
    signal: AbortSignal; onIssued(): void; onTargetResolved(scope: ServerAccountScope): void;
}>;
const handledResponses = new Set<string>();
export function isNotificationPermissionAction(parsed: ParsedNotificationTap): boolean {
    return parsed.actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1
        || parsed.actionIdentifier === PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1;
}
export function isNotificationExecutionAction(parsed: ParsedNotificationTap): boolean {
    return isNotificationPermissionAction(parsed)
        || parsed.command.kind === 'executeAction' && parsed.command.actionId === 'session.user_action.answer';
}
function responseKey(parsed: ParsedNotificationTap): string | null {
    if (!isNotificationExecutionAction(parsed)) return null;
    if (!parsed.dedupeKey && parsed.command.kind !== 'executeAction') return null;
    return JSON.stringify([parsed.accountId, parsed.dedupeKey, parsed.command]);
}
export function wasNotificationResponseHandled(parsed: ParsedNotificationTap): boolean {
    const key = responseKey(parsed); return key !== null && handledResponses.has(key);
}
export function markNotificationResponseHandled(parsed: ParsedNotificationTap): void {
    const key = responseKey(parsed); if (key !== null) handledResponses.add(key);
}
function report(outcome: NotificationPermissionOutcome, scope?: ServerAccountScope): NotificationPermissionOutcome {
    if (outcome.status !== 'ignored' && outcome.status !== 'confirmed') {
        console.warn('[notifications] Notification response requires in-app review:', outcome.status);
        try { markNotificationPermissionRecoveryNeeded(scope); }
        catch { console.warn('[notifications] Notification response recovery storage unavailable'); }
    }
    return outcome;
}
/** One lifetime includes cold execution loading, target preparation and dispatch. */
async function run(options: NotificationPermissionActionOptions,
    execute: (implementation: Execution, context: NotificationPermissionActionContext) => Promise<NotificationPermissionOutcome>,
): Promise<NotificationPermissionOutcome> {
    const lifetime = new AbortController();
    const onAbort = () => lifetime.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) lifetime.abort();
    let issued = false;
    let scope: ServerAccountScope | undefined;
    let rejectAborted: (() => void) | undefined;
    try {
        if (lifetime.signal.aborted) return report({ status: 'not_sent' });
        const aborted = new Promise<never>((_, reject) => {
            rejectAborted = () => reject(new Error('Notification response ended'));
            lifetime.signal.addEventListener('abort', rejectAborted, { once: true });
        });
        const context: NotificationPermissionActionContext = {
            signal: lifetime.signal, onTargetResolved: target => { scope = target; },
            onIssued: () => { if (lifetime.signal.aborted) throw new Error('Notification response ended'); issued = true; },
        };
        return report(await withTimeout(() => Promise.race([(async () => {
            const implementation = await (options.importExecution ?? (() => import('./notificationPermissionActionExecution')))();
            if (lifetime.signal.aborted) return { status: 'not_sent' } as const;
            return execute(implementation, context);
        })(), aborted]), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, 'notification response'), scope);
    } catch { return report({ status: issued ? 'unconfirmed' : 'not_sent' }, scope); }
    finally {
        options.signal?.removeEventListener('abort', onAbort);
        if (rejectAborted) lifetime.signal.removeEventListener('abort', rejectAborted);
        lifetime.abort();
    }
}
export function executeNotificationPermissionAction(parsed: ParsedNotificationTap,
    options: NotificationPermissionActionOptions = {},
): Promise<NotificationPermissionOutcome> {
    if (options.allowExecution === false) return Promise.resolve({ status: 'not_sent' });
    return run(options, (implementation, context) => implementation.executeNotificationPermissionAction(parsed, options, context));
}
export function handleNotificationBackgroundTask(body: unknown,
    options: NotificationPermissionActionOptions = {},
): Promise<NotificationPermissionOutcome> {
    return run(options, (implementation, context) => implementation.handleNotificationBackgroundTask(body, options, context));
}
