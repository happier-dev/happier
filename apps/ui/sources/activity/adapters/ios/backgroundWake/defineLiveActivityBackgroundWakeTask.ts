import Constants from 'expo-constants';
import type { BackgroundNotificationTaskResult, NotificationTaskPayload } from 'expo-notifications';
import type * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';
import { buildStableLiveActivitySnapshotFingerprint } from '../liveActivities/buildLiveActivitySnapshots';
import {
    resolveLiveActivityBackgroundWakePayloadActivityInstanceKey,
    resolveLiveActivityBackgroundWakePayloadApplication,
    type LiveActivityBackgroundWakeCurrentState,
} from './applyLiveActivityBackgroundWakePayload';

declare const require: (id: string) => unknown;

export const LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME = 'happier-live-activity-background-wake-v1';

type BackgroundWakeStorage = Readonly<{
    getString: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
    delete: (key: string) => void;
}>;

type LiveActivityHandle = Readonly<{
    update: (props: LiveActivitySnapshot) => Promise<void>;
    end: (
        dismissalPolicy?: 'default' | 'immediate' | { after: Date },
        props?: LiveActivitySnapshot,
        contentDate?: Date,
    ) => Promise<void>;
}>;

type LiveActivityFactory = Readonly<{
    getInstances: () => readonly LiveActivityHandle[];
}>;

export type LiveActivityBackgroundWakeStateStore = Readonly<{
    read: (activityInstanceKey: string) => LiveActivityBackgroundWakeCurrentState;
    remember: (state: NonNullable<LiveActivityBackgroundWakeCurrentState>) => void;
    rememberSnapshot: (snapshot: LiveActivitySnapshot, snapshotFingerprint?: string) => void;
    forget: (activityInstanceKey: string) => void;
    clear: () => void;
}>;

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

type BackgroundNotificationTaskResultApi = typeof BackgroundNotificationTaskResult;

type NotificationsDefinitionApi = Readonly<{
    BackgroundNotificationTaskResult: BackgroundNotificationTaskResultApi;
}>;

type NotificationsApi = NotificationsTaskRegistrationApi & NotificationsDefinitionApi;

export type LiveActivityBackgroundWakeTaskRegistrationResult =
    | Readonly<{ status: 'registered' }>
    | Readonly<{ status: 'already_registered' }>
    | Readonly<{ status: 'unregistered'; reason: 'fallback_disabled' | 'static_config_disabled' | 'platform_unsupported' }>
    | Readonly<{ status: 'already_unregistered'; reason: 'fallback_disabled' | 'static_config_disabled' | 'platform_unsupported' }>;

type LiveActivityBackgroundWakeTaskApplicationResult =
    | ReturnType<typeof resolveLiveActivityBackgroundWakePayloadApplication>
    | Readonly<{ action: 'ignore'; reason: 'activity_not_found' | 'ambiguous_activity_instances' | 'activity_state_not_found' }>;

const CURRENT_STATE_PREFIX = 'liveActivityBackgroundWake.current.';
const CURRENT_STATE_INDEX_KEY = 'liveActivityBackgroundWake.current.index.v1';
let defaultStateStorage: BackgroundWakeStorage | null = null;
let defaultStateStore: LiveActivityBackgroundWakeStateStore | null = null;

function getNotificationsApi(): NotificationsApi {
    return require('expo-notifications') as NotificationsApi;
}

function getTaskManagerRegistrationApi(): TaskManagerRegistrationApi {
    return require('expo-task-manager') as TaskManagerRegistrationApi;
}

function getTaskManagerDefinitionApi(): TaskManagerDefinitionApi {
    return require('expo-task-manager') as TaskManagerDefinitionApi;
}

function buildCurrentStateKey(activityInstanceKey: string): string {
    return `${CURRENT_STATE_PREFIX}${encodeURIComponent(activityInstanceKey)}`;
}

function readIndex(storage: BackgroundWakeStorage): string[] {
    const raw = storage.getString(CURRENT_STATE_INDEX_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    } catch {
        return [];
    }
}

function writeIndex(storage: BackgroundWakeStorage, keys: readonly string[]): void {
    storage.set(CURRENT_STATE_INDEX_KEY, JSON.stringify(Array.from(new Set(keys))));
}

function addToIndex(storage: BackgroundWakeStorage, activityInstanceKey: string): void {
    writeIndex(storage, [...readIndex(storage), activityInstanceKey]);
}

function removeFromIndex(storage: BackgroundWakeStorage, activityInstanceKey: string): void {
    writeIndex(storage, readIndex(storage).filter((key) => key !== activityInstanceKey));
}

function parseCurrentState(raw: string | undefined): LiveActivityBackgroundWakeCurrentState {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const activityInstanceKey = typeof parsed.activityInstanceKey === 'string'
            ? parsed.activityInstanceKey.trim()
            : '';
        const generatedAt = typeof parsed.generatedAt === 'number' && Number.isFinite(parsed.generatedAt)
            ? parsed.generatedAt
            : null;
        const snapshotFingerprint = typeof parsed.snapshotFingerprint === 'string'
            ? parsed.snapshotFingerprint.trim()
            : '';
        if (!activityInstanceKey || generatedAt === null || !snapshotFingerprint) return null;
        return { activityInstanceKey, generatedAt, snapshotFingerprint };
    } catch {
        return null;
    }
}

export function createLiveActivityBackgroundWakeStateStore(
    storage: BackgroundWakeStorage,
): LiveActivityBackgroundWakeStateStore {
    return {
        read(activityInstanceKey) {
            return parseCurrentState(storage.getString(buildCurrentStateKey(activityInstanceKey)));
        },
        remember(state) {
            storage.set(buildCurrentStateKey(state.activityInstanceKey), JSON.stringify(state));
            addToIndex(storage, state.activityInstanceKey);
        },
        rememberSnapshot(snapshot, snapshotFingerprint) {
            this.remember({
                activityInstanceKey: snapshot.activityInstanceKey,
                generatedAt: snapshot.generatedAt,
                snapshotFingerprint: snapshotFingerprint ?? buildStableLiveActivitySnapshotFingerprint(snapshot),
            });
        },
        forget(activityInstanceKey) {
            storage.delete(buildCurrentStateKey(activityInstanceKey));
            removeFromIndex(storage, activityInstanceKey);
        },
        clear() {
            for (const activityInstanceKey of readIndex(storage)) {
                storage.delete(buildCurrentStateKey(activityInstanceKey));
            }
            storage.delete(CURRENT_STATE_INDEX_KEY);
        },
    };
}

function getDefaultStateStorage(): BackgroundWakeStorage {
    if (defaultStateStorage) return defaultStateStorage;
    const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    defaultStateStorage = new MMKV({ id: 'live-activity-background-wake' });
    return defaultStateStorage;
}

function getDefaultStateStore(): LiveActivityBackgroundWakeStateStore {
    if (defaultStateStore) return defaultStateStore;
    defaultStateStore = createLiveActivityBackgroundWakeStateStore(getDefaultStateStorage());
    return defaultStateStore;
}

export function readLiveActivityBackgroundWakeCurrentState(
    activityInstanceKey: string,
): LiveActivityBackgroundWakeCurrentState {
    return getDefaultStateStore().read(activityInstanceKey);
}

export function rememberLiveActivityBackgroundWakeSnapshot(
    snapshot: LiveActivitySnapshot,
    snapshotFingerprint?: string,
): void {
    getDefaultStateStore().rememberSnapshot(snapshot, snapshotFingerprint);
}

export function forgetLiveActivityBackgroundWakeCurrentState(activityInstanceKey: string): void {
    getDefaultStateStore().forget(activityInstanceKey);
}

export function clearLiveActivityBackgroundWakeCurrentStates(): void {
    getDefaultStateStore().clear();
}

export function resolveLiveActivityBackgroundWakeStaticConfigSupported(): boolean {
    const appExtra = Constants.expoConfig?.extra as Readonly<{
        app?: Readonly<{ iosBackgroundWakeNotificationsEnabled?: unknown }>;
    }> | undefined;
    return appExtra?.app?.iosBackgroundWakeNotificationsEnabled === true;
}

function resolveDisabledReason(params: Readonly<{
    fallbackEnabled: boolean;
    staticConfigSupportsBackgroundWake: boolean;
    platformOS: string;
}>): 'fallback_disabled' | 'static_config_disabled' | 'platform_unsupported' | null {
    if (params.platformOS !== 'ios') return 'platform_unsupported';
    if (!params.staticConfigSupportsBackgroundWake) return 'static_config_disabled';
    if (!params.fallbackEnabled) return 'fallback_disabled';
    return null;
}

export async function syncLiveActivityBackgroundWakeTaskRegistration(params: Readonly<{
    fallbackEnabled: boolean;
    staticConfigSupportsBackgroundWake?: boolean;
    platformOS?: string;
    notifications?: NotificationsTaskRegistrationApi;
    taskManager?: TaskManagerRegistrationApi;
}>): Promise<LiveActivityBackgroundWakeTaskRegistrationResult> {
    const platformOS = params.platformOS ?? Platform.OS;
    const staticConfigSupportsBackgroundWake =
        params.staticConfigSupportsBackgroundWake ?? resolveLiveActivityBackgroundWakeStaticConfigSupported();
    if (platformOS !== 'ios') {
        return { status: 'already_unregistered', reason: 'platform_unsupported' };
    }

    const notifications = params.notifications ?? getNotificationsApi();
    const taskManager = params.taskManager ?? getTaskManagerRegistrationApi();
    const registered = await taskManager.isTaskRegisteredAsync(LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME);
    const disabledReason = resolveDisabledReason({
        fallbackEnabled: params.fallbackEnabled,
        staticConfigSupportsBackgroundWake,
        platformOS,
    });

    if (disabledReason) {
        if (!registered) return { status: 'already_unregistered', reason: disabledReason };
        await notifications.unregisterTaskAsync(LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME);
        return { status: 'unregistered', reason: disabledReason };
    }

    if (registered) return { status: 'already_registered' };
    await notifications.registerTaskAsync(LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME);
    return { status: 'registered' };
}

function readTaskPayload(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const record = raw as Readonly<Record<string, unknown>>;
    if (typeof record.dataString === 'string') {
        try {
            return JSON.parse(record.dataString);
        } catch {
            return null;
        }
    }
    if (record.type === 'happier.liveActivityRemoteUpdate.v1') return record;
    const nestedData = record.data;
    if (nestedData && typeof nestedData === 'object') {
        return readTaskPayload(nestedData);
    }
    return raw;
}

export async function applyLiveActivityBackgroundWakeTaskPayload(params: Readonly<{
    payload: unknown;
    stateStore?: LiveActivityBackgroundWakeStateStore;
    liveActivityFactory?: LiveActivityFactory;
}>): Promise<LiveActivityBackgroundWakeTaskApplicationResult> {
    const payload = readTaskPayload(params.payload);
    const stateStore = params.stateStore ?? getDefaultStateStore();
    const activityInstanceKey = resolveLiveActivityBackgroundWakePayloadActivityInstanceKey(payload);
    const current = activityInstanceKey ? stateStore.read(activityInstanceKey) : null;
    if (activityInstanceKey && !current) {
        return { action: 'ignore', reason: 'activity_state_not_found' };
    }
    const result = resolveLiveActivityBackgroundWakePayloadApplication({ payload, current });
    if (result.action === 'ignore') return result;

    const liveActivityFactory = params.liveActivityFactory
        ?? (await import('../runtime/iosActivityWidgetModules')).HappierFocusLiveActivity;
    const instances = liveActivityFactory.getInstances();
    if (instances.length === 0) {
        return { action: 'ignore', reason: 'activity_not_found' };
    }
    if (instances.length > 1) {
        return { action: 'ignore', reason: 'ambiguous_activity_instances' };
    }
    const instance = instances[0];

    if (result.action === 'apply_end') {
        await instance.end('immediate', undefined, new Date());
        stateStore.forget(result.activityInstanceKey);
        return result;
    }

    await instance.update(result.snapshot);
    stateStore.rememberSnapshot(result.snapshot, result.snapshotFingerprint);
    return result;
}

export function defineLiveActivityBackgroundWakeTask(params: Readonly<{
    taskManager?: TaskManagerDefinitionApi;
    notifications?: NotificationsDefinitionApi;
    platformOS?: string;
}> = {}): Readonly<{ status: 'defined' | 'already_defined' | 'skipped_platform' }> {
    const platformOS = params.platformOS ?? Platform.OS;
    if (platformOS !== 'ios') {
        return { status: 'skipped_platform' };
    }

    const taskManager = params.taskManager ?? getTaskManagerDefinitionApi();
    const notifications = params.notifications ?? getNotificationsApi();
    if (taskManager.isTaskDefined?.(LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME)) {
        return { status: 'already_defined' };
    }

    taskManager.defineTask<NotificationTaskPayload>(
        LIVE_ACTIVITY_BACKGROUND_WAKE_TASK_NAME,
        async ({ data, error }) => {
            if (error) return notifications.BackgroundNotificationTaskResult.Failed;
            const result = await applyLiveActivityBackgroundWakeTaskPayload({ payload: data });
            return result.action === 'ignore'
                ? notifications.BackgroundNotificationTaskResult.NoData
                : notifications.BackgroundNotificationTaskResult.NewData;
        },
    );
    return { status: 'defined' };
}

if (Platform.OS === 'ios') {
    defineLiveActivityBackgroundWakeTask();
}
