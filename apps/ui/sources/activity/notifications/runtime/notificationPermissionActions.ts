import type { ParsedNotificationTap } from '../notificationRouting';
import type { NotificationPermissionOutcome } from './notificationPermissionCoordinator';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { withTimeout } from '@/utils/timing/time';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type NotificationPermissionExecution = typeof import('./notificationPermissionActionExecution');

export type NotificationPermissionActionOptions = Readonly<{
    allowExecution?: boolean;
    signal?: AbortSignal;
    // Bundle-loader boundaries; parsing, admission and dispatch remain real.
    importExecution?: () => Promise<NotificationPermissionExecution>;
    importTarget?: () => Promise<typeof import('./resolveNotificationPermissionTarget')>;
}>;

export type NotificationPermissionActionContext = Readonly<{
    signal: AbortSignal;
    onIssued(): void;
    onTargetResolved(scope: ServerAccountScope): void;
}>;

function reportOutcome(outcome: NotificationPermissionOutcome, scope?: ServerAccountScope): NotificationPermissionOutcome {
    if (outcome.status !== 'confirmed' && outcome.status !== 'ignored') {
        console.warn('[notifications] Permission action requires in-app review:', outcome.status);
        try {
            markNotificationPermissionRecoveryNeeded(scope);
        } catch {
            console.warn('[notifications] Permission action recovery storage unavailable');
        }
    }
    return outcome;
}

/** One lifetime covers cold bundle loading, preparation and permission dispatch. */
async function runPermissionAction(
    options: NotificationPermissionActionOptions,
    execute: (implementation: NotificationPermissionExecution, context: NotificationPermissionActionContext) => Promise<NotificationPermissionOutcome>,
): Promise<NotificationPermissionOutcome> {
    const lifetime = new AbortController();
    const onAbort = () => lifetime.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) lifetime.abort();
    let issued = false;
    let scope: ServerAccountScope | undefined;
    let rejectAborted: (() => void) | undefined;
    try {
        if (lifetime.signal.aborted) return reportOutcome({ status: 'not_sent' });
        const aborted = new Promise<never>((_, reject) => {
            rejectAborted = () => reject(new Error('Notification action ended'));
            lifetime.signal.addEventListener('abort', rejectAborted, { once: true });
        });
        const context: NotificationPermissionActionContext = {
            signal: lifetime.signal,
            onTargetResolved: (target) => { scope = target; },
            onIssued: () => {
                if (lifetime.signal.aborted) throw new Error('Notification action ended');
                issued = true;
            },
        };
        return reportOutcome(await withTimeout(() => Promise.race([(async () => {
            const implementation = await (options.importExecution ?? (() => import('./notificationPermissionActionExecution')))();
            if (lifetime.signal.aborted) return { status: 'not_sent' } as const;
            return execute(implementation, context);
        })(), aborted]), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, 'notification permission action'), scope);
    } catch {
        return reportOutcome({ status: issued ? 'unconfirmed' : 'not_sent' }, scope);
    } finally {
        options.signal?.removeEventListener('abort', onAbort);
        if (rejectAborted) lifetime.signal.removeEventListener('abort', rejectAborted);
        lifetime.abort();
    }
}

export function executeNotificationPermissionAction(
    parsed: ParsedNotificationTap,
    options: NotificationPermissionActionOptions = {},
): Promise<NotificationPermissionOutcome> {
    // Cached observations neither load execution nor create another recovery notice.
    if (options.allowExecution === false) return Promise.resolve({ status: 'not_sent' });
    return runPermissionAction(options, (implementation, context) =>
        implementation.executeNotificationPermissionAction(parsed, options, context));
}

export function handleNotificationBackgroundTask(
    body: unknown,
    options: NotificationPermissionActionOptions = {},
): Promise<NotificationPermissionOutcome> {
    return runPermissionAction(options, (implementation, context) =>
        implementation.handleNotificationBackgroundTask(body, options, context));
}
