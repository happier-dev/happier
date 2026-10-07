import type { BackgroundNotificationTaskResult, NotificationTaskPayload } from 'expo-notifications';
import type * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { parseSessionChangedWakeV1, type SessionChangedWakeV1 } from '@happier-dev/protocol/push/sessionChangedWake';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { withMutedActivityLocalNotifications } from '../runtime/activityLocalNotificationBus';

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
    | Readonly<{ action: 'ignore'; reason: 'not_a_session_changed_wake' | 'session_unavailable' }>;

export type SessionChangedBackgroundWakeTaskRegistrationResult =
    | Readonly<{ status: 'registered' }>
    | Readonly<{ status: 'already_registered' }>
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
    const direct = parseSessionChangedWakeV1(raw);
    if (direct) return direct;
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Readonly<Record<string, unknown>>;
    if (typeof record.dataString === 'string') {
        try {
            return readSessionChangedBackgroundWakePayload(JSON.parse(record.dataString));
        } catch {
            return null;
        }
    }
    const nested = record.data ?? record.body ?? record.notification;
    if (nested && typeof nested === 'object') {
        return readSessionChangedBackgroundWakePayload(nested);
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
}>): Promise<SessionChangedBackgroundWakeResult> {
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
    return {
        action: 'reconciled',
        sessionId: wake.sessionId,
        ...(wake.serverId ? { serverId: wake.serverId } : {}),
    };
}

export async function syncSessionChangedBackgroundWakeTaskRegistration(params: Readonly<{
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
    const registered = await taskManager.isTaskRegisteredAsync(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);

    if (registered) return { status: 'already_registered' };
    await notifications.registerTaskAsync(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);
    return { status: 'registered' };
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
            const result = await applySessionChangedBackgroundWakePayload({ payload: data });
            return result.action === 'reconciled'
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
