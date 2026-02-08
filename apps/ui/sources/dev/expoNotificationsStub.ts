// Vitest/node stub for `expo-notifications`.
//
// The real `expo-notifications` package performs native registration side-effects at import time
// and expects Expo runtime modules that don't exist in Vitest's node environment.
//
// For unit tests we only need a small surface area so modules importing Notifications can load.

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';

export const AndroidImportance = {
    UNKNOWN: 0,
    UNSPECIFIED: 1,
    NONE: 2,
    MIN: 3,
    LOW: 4,
    DEFAULT: 5,
    HIGH: 6,
    MAX: 7,
} as const;

export function setNotificationHandler(_handler: unknown) {
    // no-op
}

export async function setNotificationChannelAsync(_id: string, _channel: unknown): Promise<void> {
    // no-op
}

export async function getPermissionsAsync(): Promise<{ status: PermissionStatus }> {
    return { status: 'denied' };
}

export async function requestPermissionsAsync(): Promise<{ status: PermissionStatus }> {
    return { status: 'denied' };
}

export async function getExpoPushTokenAsync(_params?: unknown): Promise<{ data: string }> {
    return { data: 'expo-push-token-stub' };
}

export async function getLastNotificationResponseAsync(): Promise<unknown> {
    return null;
}

export function addNotificationReceivedListener(_listener: unknown) {
    return { remove: () => {} };
}

export function addNotificationResponseReceivedListener(_listener: unknown) {
    return { remove: () => {} };
}

export async function dismissAllNotificationsAsync(): Promise<void> {
    // no-op
}
