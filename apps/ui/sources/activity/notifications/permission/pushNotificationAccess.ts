import Constants from 'expo-constants';
import { Platform } from 'react-native';

import {
    loadExpoNotifications,
    type ExpoNotificationsModule,
    type LoadExpoNotificationsOptions,
} from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';

/**
 * Canonical bounded access to the Expo notification runtime.
 *
 * Every call here crosses into a native module (and, in a development client, a lazily fetched
 * bundle). Those boundaries can stall indefinitely, so each call carries a deadline and returns a
 * typed outcome instead of throwing or hanging: callers must be able to distinguish "the runtime
 * could not be reached" from "the user declined" and surface something actionable.
 */
export const PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS = 8_000;

export type PushPermissionStatus = 'unsupported' | 'granted' | 'denied' | 'undetermined';

export type PushPermissionState = Readonly<{
    status: PushPermissionStatus;
    granted: boolean;
    canAskAgain: boolean;
}>;

/** The notification runtime itself could not answer. Distinct from a user-visible permission state. */
export type PushNotificationRuntimeFailure = 'runtime_unavailable' | 'runtime_timeout';

export type PushPermissionOutcome =
    | Readonly<{ ok: true; permission: PushPermissionState }>
    | Readonly<{ ok: false; reason: PushNotificationRuntimeFailure }>;

export type ExpoPushTokenOutcome =
    | Readonly<{ ok: true; token: string }>
    | Readonly<{ ok: false; reason: PushNotificationRuntimeFailure | 'token_unavailable' }>;

export type PushNotificationAccessOptions = Readonly<{
    timeoutMs?: number;
    loadModule?: (opts?: LoadExpoNotificationsOptions) => Promise<ExpoNotificationsModule>;
}>;

const UNSUPPORTED_PERMISSION: PushPermissionState = {
    status: 'unsupported',
    granted: false,
    canAskAgain: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPushNotificationRuntimeSupported(): boolean {
    return Platform.OS !== 'web';
}

/**
 * The EAS project id scopes the Expo push token. Resolved from the Expo config with the legacy
 * `easConfig` fallback so a build produced before the dynamic-config migration still works.
 */
export function resolveExpoProjectId(): string | null {
    try {
        const constants = Constants as unknown;
        if (!isRecord(constants)) return null;

        const expoConfig = isRecord(constants.expoConfig) ? constants.expoConfig : null;
        const extra = expoConfig && isRecord(expoConfig.extra) ? expoConfig.extra : null;
        const easExtra = extra && isRecord(extra.eas) ? extra.eas : null;
        const easConfig = isRecord(constants.easConfig) ? constants.easConfig : null;

        const candidate = typeof easExtra?.projectId === 'string'
            ? easExtra.projectId
            : typeof easConfig?.projectId === 'string'
                ? easConfig.projectId
                : null;
        const trimmed = candidate?.trim() ?? '';
        return trimmed ? trimmed : null;
    } catch {
        return null;
    }
}

function normalizePermissionState(result: unknown): PushPermissionState {
    const record = isRecord(result) ? result : {};
    const rawStatus = typeof record.status === 'string' ? record.status : '';
    const status: PushPermissionStatus =
        rawStatus === 'granted' || rawStatus === 'denied' || rawStatus === 'undetermined'
            ? rawStatus
            : 'undetermined';
    return {
        status,
        granted: record.granted === true || status === 'granted',
        canAskAgain: record.canAskAgain === true,
    };
}

function runtimeFailureReason(error: unknown): PushNotificationRuntimeFailure {
    return isRecord(error) && error.name === 'AsyncTimeoutError' ? 'runtime_timeout' : 'runtime_unavailable';
}

async function withNotificationRuntime<T>(
    opts: PushNotificationAccessOptions | undefined,
    operationName: string,
    run: (notifications: ExpoNotificationsModule) => Promise<T>,
): Promise<Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: PushNotificationRuntimeFailure }>> {
    const timeoutMs = opts?.timeoutMs ?? PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS;
    const loadModule = opts?.loadModule ?? loadExpoNotifications;
    try {
        // The load and the native call each get the deadline; neither may strand the caller.
        const notifications = await withTimeout(
            () => loadModule({ timeoutMs }),
            timeoutMs,
            'expo-notifications module load',
        );
        const value = await withTimeout(() => run(notifications), timeoutMs, operationName);
        return { ok: true, value };
    } catch (error) {
        return { ok: false, reason: runtimeFailureReason(error) };
    }
}

export async function readPushPermission(
    opts?: PushNotificationAccessOptions,
): Promise<PushPermissionOutcome> {
    if (!isPushNotificationRuntimeSupported()) {
        return { ok: true, permission: UNSUPPORTED_PERMISSION };
    }
    const outcome = await withNotificationRuntime(
        opts,
        'expo-notifications getPermissionsAsync',
        (notifications) => notifications.getPermissionsAsync(),
    );
    return outcome.ok
        ? { ok: true, permission: normalizePermissionState(outcome.value) }
        : outcome;
}

export async function requestPushPermission(
    opts?: PushNotificationAccessOptions,
): Promise<PushPermissionOutcome> {
    if (!isPushNotificationRuntimeSupported()) {
        return { ok: true, permission: UNSUPPORTED_PERMISSION };
    }
    const outcome = await withNotificationRuntime(
        opts,
        'expo-notifications requestPermissionsAsync',
        (notifications) => notifications.requestPermissionsAsync(),
    );
    return outcome.ok
        ? { ok: true, permission: normalizePermissionState(outcome.value) }
        : outcome;
}

export async function readExpoPushToken(
    opts?: PushNotificationAccessOptions,
): Promise<ExpoPushTokenOutcome> {
    if (!isPushNotificationRuntimeSupported()) {
        return { ok: false, reason: 'token_unavailable' };
    }

    const projectId = resolveExpoProjectId();
    const outcome = await withNotificationRuntime(
        opts,
        'expo-notifications getExpoPushTokenAsync',
        async (notifications) => {
            try {
                const result = projectId
                    ? await notifications.getExpoPushTokenAsync({ projectId })
                    : await notifications.getExpoPushTokenAsync();
                return typeof result?.data === 'string' ? result.data.trim() : '';
            } catch {
                // A device that cannot mint a token (missing entitlement, simulator, revoked APNs
                // registration) is a device-level fact, not a runtime reachability failure.
                return '';
            }
        },
    );

    if (!outcome.ok) return outcome;
    return outcome.value ? { ok: true, token: outcome.value } : { ok: false, reason: 'token_unavailable' };
}
