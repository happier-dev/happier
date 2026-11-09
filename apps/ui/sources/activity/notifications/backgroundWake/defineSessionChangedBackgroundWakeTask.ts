import type { BackgroundNotificationTaskResult, NotificationTaskPayload } from 'expo-notifications';
import type * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { parseSessionChangedWakeV1, type SessionChangedWakeV1 } from '@happier-dev/protocol/push/sessionChangedWake';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { withMutedActivityLocalNotifications } from '../runtime/activityLocalNotificationBus';
import { resolveIncomingMachineRemoteAlert } from '../remoteAlerts/machineRemoteAlertRouting';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { readExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import { loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { reconcileGuardStopWarningNotifications } from '../guardStopWarningLifecycle';
import { PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS } from '../permission/pushNotificationAccess';
import { withTimeout } from '@/utils/timing/time';
import { handleNotificationBackgroundTask } from '../runtime/notificationPermissionActions';

declare const require: (id: string) => unknown;

/**
 * The closed-app consumer of the Home's content-free `session_changed` wake.
 *
 * Both push platforms deliver it, and neither guarantees it. On iOS it arrives
 * as a `content-available` background notification, which the system may
 * throttle, delay or discard and never delivers to a user-terminated app. On
 * Android the single Firebase entry point lives in the isolated
 * `:happier_activity_notifications` process, which recognizes the wake and
 * hands it to the app process
 * (`modules/happier-activity-notifications/android/.../ActivityNotificationMainProcessHandoff.kt`),
 * where this task runs — so a loaded-but-backgrounded app is woken and a fully
 * terminated one is not. Best effort by platform contract on both, never a
 * guaranteed alert.
 */
export const SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME = 'happier-session-changed-background-wake-v1';

type NotificationsTaskRegistrationApi = Readonly<{
    registerTaskAsync: (taskName: string) => Promise<unknown>;
    unregisterTaskAsync: (taskName: string) => Promise<unknown>;
}>;

type TaskManagerRegistrationApi = Readonly<{
    isTaskRegisteredAsync: (taskName: string) => Promise<boolean>;
    isTaskDefined: (taskName: string) => boolean;
    isAvailableAsync: () => Promise<boolean>;
}>;

type TaskManagerDefinitionApi = Readonly<{
    defineTask: typeof TaskManager.defineTask;
    isTaskDefined?: (taskName: string) => boolean;
}>;

type NotificationsDefinitionApi = Readonly<{
    /**
     * Only the three outcomes the executor below returns. Naming them instead of
     * the whole `expo-notifications` enum object keeps this a real boundary a
     * platform stub can satisfy without restating the module.
     */
    BackgroundNotificationTaskResult: Readonly<Record<
        'Failed' | 'NewData' | 'NoData',
        BackgroundNotificationTaskResult
    >>;
}>;

/**
 * Reconciles one exact Home for the woken Session.
 *
 * Everything user-visible stays with its incumbent owner: hydrating the exact
 * Home republishes the canonical transcript/ready facts, the sync owner emits
 * the existing Activity event, and `ActivityLocalNotificationRuntime` applies
 * this device's real Account and device notification policy and content builder
 * before any local notification is posted. This consumer therefore holds no
 * policy, no copy and no second dedupe: repeated wakes converge because
 * hydration is idempotent and that runtime already dedupes on the canonical
 * Activity event identity.
 */
export type SessionChangedWakeReconciler = (wake: SessionChangedWakeV1) => Promise<boolean>;

export type SessionChangedBackgroundWakeResult =
    | Readonly<{ action: 'reconciled'; sessionId: string; serverId?: string }>
    | Readonly<{ action: 'dismissed'; machineId: string; serverId: string }>
    | Readonly<{ action: 'ignore'; reason: 'not_a_session_changed_wake' | 'session_unavailable' | 'machine_unavailable' }>;

export type SessionChangedBackgroundWakeTaskRegistrationResult =
    | Readonly<{ status: 'registered' }>
    | Readonly<{ status: 'already_registered' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'already_unregistered'; reason: 'platform_unsupported' }>;

function getNotificationsApi(): NotificationsTaskRegistrationApi & NotificationsDefinitionApi {
    return require('expo-notifications') as NotificationsTaskRegistrationApi & NotificationsDefinitionApi;
}

function getTaskManagerRegistrationApi(): TaskManagerRegistrationApi {
    return require('expo-task-manager') as TaskManagerRegistrationApi;
}

function getTaskManagerDefinitionApi(): TaskManagerDefinitionApi {
    return require('expo-task-manager') as TaskManagerDefinitionApi;
}

/**
 * Unwraps the transport envelopes the same payload arrives in: Expo's iOS
 * background task nests the push `data` bag, and the Android data message can
 * arrive with the bag serialized in `dataString`. Anything that is not exactly
 * the strict wake payload is rejected rather than partially trusted.
 */
export function readSessionChangedBackgroundWakePayload(raw: unknown): SessionChangedWakeV1 | null {
    return readBackgroundPayload(raw, parseSessionChangedWakeV1);
}

function readBackgroundPayload<T>(raw: unknown, parse: (raw: unknown) => T | null): T | null {
    const direct = parse(raw);
    if (direct) return direct;
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Readonly<Record<string, unknown>>;
    if (typeof record.dataString === 'string') {
        try {
            return readBackgroundPayload(JSON.parse(record.dataString), parse);
        } catch {
            return null;
        }
    }
    const nested = record.data ?? record.body ?? record.notification;
    if (nested && typeof nested === 'object') {
        return readBackgroundPayload(nested, parse);
    }
    return null;
}

async function reconcileExactHomeSession(wake: SessionChangedWakeV1): Promise<boolean> {
    const result = await getSyncSingleton().ensureSessionVisibleForMessageRoute(wake.sessionId, {
        forceRefresh: true,
        hydrateMessages: true,
        ...(wake.alert === 'muted' ? { awaitMessageHydration: true } : {}),
        ...(wake.serverId ? { serverId: wake.serverId } : {}),
    });
    return result.kind === 'available';
}

export async function applySessionChangedBackgroundWakePayload(params: Readonly<{
    payload: unknown;
    reconcile?: SessionChangedWakeReconciler;
    /** Native dismissal boundary; the same Expo task owns receipt of data-only recovery. */
    notifications?: Pick<ExpoNotificationsModule, 'dismissNotificationAsync' | 'getPresentedNotificationsAsync'>;
}>): Promise<SessionChangedBackgroundWakeResult> {
    const machine = readBackgroundPayload(params.payload, raw => {
        const incoming = resolveIncomingMachineRemoteAlert(raw);
        return incoming.kind === 'not_machine_alert' ? null : incoming;
    });
    if (machine) {
        if (machine.kind !== 'routable' || machine.alert.phase !== 'recovered') return { action: 'ignore', reason: 'machine_unavailable' };
        const notifications = params.notifications ?? await loadExpoNotifications();
        const scope = await resolveServerCredentialAccountScope(machine.serverId);
        if (scope.kind !== 'bound' || scope.scope.accountId !== machine.alert.accountId || !readExactHomeAccountSettings(scope.scope)) {
            return { action: 'ignore', reason: 'machine_unavailable' };
        }
        const presented = await notifications.getPresentedNotificationsAsync();
        for (const notification of presented) {
            const notice = resolveIncomingMachineRemoteAlert(notification.request.content.data);
            if (notice.kind !== 'routable' || notice.alert.phase !== 'offline'
                || notice.alert.serverId !== machine.alert.serverId || notice.alert.accountId !== machine.alert.accountId
                || notice.alert.machineId !== machine.alert.machineId) continue;
            // Listing notices and each earlier dismissal can await native work. Re-admit the exact Account/Home before every outward dismissal.
            const currentScope = await resolveServerCredentialAccountScope(machine.serverId);
            const current = resolveIncomingMachineRemoteAlert(machine.alert);
            if (currentScope.kind !== 'bound' || currentScope.scope.accountId !== machine.alert.accountId
                || !readExactHomeAccountSettings(currentScope.scope) || current.kind !== 'routable' || current.serverId !== machine.serverId) {
                return { action: 'ignore', reason: 'machine_unavailable' };
            }
            // iOS's OS request id is not the payload's stable thread/tag identity.
            await notifications.dismissNotificationAsync(notification.request.identifier);
        }
        return { action: 'dismissed', serverId: machine.serverId, machineId: machine.alert.machineId };
    }
    const wake = readSessionChangedBackgroundWakePayload(params.payload);
    if (!wake) return { action: 'ignore', reason: 'not_a_session_changed_wake' };
    const reconcile = params.reconcile ?? reconcileExactHomeSession;
    const reconciled = wake.alert === 'muted'
        ? await withMutedActivityLocalNotifications({
            serverId: wake.serverId ?? getActiveServerSnapshot().serverId,
            sessionId: wake.sessionId,
        }, () => reconcile(wake))
        : await reconcile(wake);
    if (!reconciled) return { action: 'ignore', reason: 'session_unavailable' };
    if (wake.serverId) await reconcileGuardStopWarningNotifications({ notifications: params.notifications,
        session: { serverId: wake.serverId, sessionId: wake.sessionId } });
    return {
        action: 'reconciled',
        sessionId: wake.sessionId,
        ...(wake.serverId ? { serverId: wake.serverId } : {}),
    };
}

async function registerSessionChangedBackgroundWakeTask(params: Readonly<{
    platformOS?: string;
    notifications?: NotificationsTaskRegistrationApi;
    taskManager?: TaskManagerRegistrationApi;
}> = {}): Promise<SessionChangedBackgroundWakeTaskRegistrationResult> {
    const platformOS = params.platformOS ?? Platform.OS;
    if (platformOS !== 'ios' && platformOS !== 'android') {
        return { status: 'already_unregistered', reason: 'platform_unsupported' };
    }

    const notifications = params.notifications ?? getNotificationsApi();
    const taskManager = params.taskManager ?? getTaskManagerRegistrationApi();
    if (!taskManager.isTaskDefined(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME)
        || !await taskManager.isAvailableAsync()) return { status: 'unavailable' };
    const registered = await taskManager.isTaskRegisteredAsync(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);

    if (registered) return { status: 'already_registered' };
    await notifications.registerTaskAsync(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);
    return { status: 'registered' };
}

let runtimeRegistration: Promise<SessionChangedBackgroundWakeTaskRegistrationResult> | undefined;

/** App bootstrap and mounted reconciliation share the same native registration. */
export function syncSessionChangedBackgroundWakeTaskRegistration(
    params: Parameters<typeof registerSessionChangedBackgroundWakeTask>[0] = {},
): Promise<SessionChangedBackgroundWakeTaskRegistrationResult> {
    const register = async (): Promise<SessionChangedBackgroundWakeTaskRegistrationResult> => {
        try {
            const result = await withTimeout(() => registerSessionChangedBackgroundWakeTask(params),
                PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS, 'notification task registration');
            if (result.status === 'unavailable') console.warn('[notifications] Background notification registration unavailable');
            return result;
        } catch {
            console.warn('[notifications] Background notification registration unavailable');
            return { status: 'unavailable' };
        }
    };
    if (params.notifications || params.taskManager || params.platformOS) return register();
    runtimeRegistration ??= register();
    return runtimeRegistration;
}

export function defineSessionChangedBackgroundWakeTask(params: Readonly<{
    taskManager?: TaskManagerDefinitionApi;
    notifications?: NotificationsDefinitionApi;
    platformOS?: string;
}> = {}): Readonly<{ status: 'defined' | 'already_defined' | 'skipped_platform' }> {
    const platformOS = params.platformOS ?? Platform.OS;
    if (platformOS !== 'ios' && platformOS !== 'android') {
        return { status: 'skipped_platform' };
    }

    const taskManager = params.taskManager ?? getTaskManagerDefinitionApi();
    const notifications = params.notifications ?? getNotificationsApi();
    if (taskManager.isTaskDefined?.(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME)) {
        return { status: 'already_defined' };
    }

    taskManager.defineTask<NotificationTaskPayload>(
        SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME,
        async ({ data, error }) => {
            if (error) return notifications.BackgroundNotificationTaskResult.Failed;
            if (platformOS === 'android') {
                const outcome = await handleNotificationBackgroundTask({ data });
                if (outcome.status !== 'ignored') {
                    return outcome.status === 'confirmed' ? notifications.BackgroundNotificationTaskResult.NewData
                        : notifications.BackgroundNotificationTaskResult.Failed;
                }
            }
            const result = await applySessionChangedBackgroundWakePayload({ payload: data });
            return result.action === 'reconciled' || result.action === 'dismissed'
                ? notifications.BackgroundNotificationTaskResult.NewData
                : notifications.BackgroundNotificationTaskResult.NoData;
        },
    );
    return { status: 'defined' };
}

// Defining the task is a module-load side effect on purpose: on Android the app
// process must already carry the consumer when the isolated Firebase process
// hands a wake over, and `defineSessionChangedBackgroundWakeTask` is the one
// owner of which platforms can run it.
defineSessionChangedBackgroundWakeTask();
