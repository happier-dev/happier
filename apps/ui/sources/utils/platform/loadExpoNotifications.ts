export type ExpoNotificationsModule = typeof import('expo-notifications');

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

export async function loadExpoNotifications(): Promise<ExpoNotificationsModule> {
    return resolveExpoNotificationsModule(await import('expo-notifications'));
}
