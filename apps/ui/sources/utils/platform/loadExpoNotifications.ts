import { withTimeout } from '@/utils/timing/time';

export type ExpoNotificationsModule = typeof import('expo-notifications');

/**
 * In a development client `import('expo-notifications')` is not a local registry lookup: Expo's dev
 * server enables lazy bundling, so the async chunk is fetched over the network at call time. A dev
 * server that has become unreachable leaves that promise pending forever, which previously stalled
 * push-token registration and the notification troubleshooting screen with no error and no recovery.
 */
export const EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function hasExpoNotificationExport(module: Record<string, unknown>): boolean {
    return (
        'setNotificationHandler' in module
        || 'getPermissionsAsync' in module
        || 'getLastNotificationResponseAsync' in module
        || 'scheduleNotificationAsync' in module
        || 'setBadgeCountAsync' in module
    );
}

export function resolveExpoNotificationsModule(module: unknown): ExpoNotificationsModule {
    if (isRecord(module) && hasExpoNotificationExport(module)) {
        return module as ExpoNotificationsModule;
    }
    if (isRecord(module) && module.default) {
        return module.default as ExpoNotificationsModule;
    }
    return module as ExpoNotificationsModule;
}

export type LoadExpoNotificationsOptions = Readonly<{
    /**
     * Deadline for the bundle load. Non-positive disables the bound.
     */
    timeoutMs?: number;
    /**
     * Bundle-loader seam. Defaults to the real dynamic import; overridden in tests to exercise a
     * loader that stalls, which is the failure this bound exists for.
     */
    importModule?: () => Promise<unknown>;
}>;

export async function loadExpoNotifications(
    opts?: LoadExpoNotificationsOptions,
): Promise<ExpoNotificationsModule> {
    const importModule = opts?.importModule ?? (() => import('expo-notifications'));
    const timeoutMs = opts?.timeoutMs ?? EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS;
    return resolveExpoNotificationsModule(
        await withTimeout(importModule, timeoutMs, 'expo-notifications module load'),
    );
}
