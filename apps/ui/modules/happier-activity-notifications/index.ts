import { requireOptionalNativeModule } from 'expo-modules-core';
import { ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1 } from '@happier-dev/protocol/push/activityRemoteAlert';

/**
 * The alert categories a native consumer may present, mirroring
 * `ActivityRemoteAlertEventV1` in `packages/protocol/src/push/activityRemoteAlert.ts`.
 * A platform reports the subset its shipped consumer actually admits.
 */
export const ACTIVITY_NOTIFICATION_EVENTS = ACTIVITY_REMOTE_ALERT_EVENT_TYPES_V1;

export type ActivityNotificationEventId = (typeof ACTIVITY_NOTIFICATION_EVENTS)[number];

export type ActivityNotificationCapabilities = Readonly<{
    v: 1;
    platform: 'ios' | 'android';
    events: readonly ActivityNotificationEventId[];
}>;

type ActivityNotificationsNativeModule = Readonly<{
    prepareStorage(): string;
    prepareContext(serializedContext: string): boolean;
    removeContext(serverId: string, accountId: string | null, registrationId: string | null): boolean;
    clearContext(): void;
    getCapabilities(): unknown;
}>;

function nativeModule(): ActivityNotificationsNativeModule | null {
    return requireOptionalNativeModule<ActivityNotificationsNativeModule>('HappierActivityNotifications');
}

function readEvents(value: unknown): readonly ActivityNotificationEventId[] | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const events: ActivityNotificationEventId[] = [];
    for (const entry of value) {
        const admitted = ACTIVITY_NOTIFICATION_EVENTS.find((event) => event === entry);
        if (!admitted || events.includes(admitted)) return null;
        events.push(admitted);
    }
    return events;
}

export function readActivityNotificationCapabilities(): ActivityNotificationCapabilities | null {
    const value = nativeModule()?.getCapabilities();
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (row.v !== 1 || (row.platform !== 'ios' && row.platform !== 'android')) return null;
    const events = readEvents(row.events);
    return events ? { v: 1, platform: row.platform, events } : null;
}

export function prepareActivityNotificationStorage(): string | null {
    return nativeModule()?.prepareStorage() ?? null;
}

export function prepareActivityNotificationContext(serializedContext: string): boolean {
    return nativeModule()?.prepareContext(serializedContext) === true;
}

export function removeActivityNotificationContext(
    serverId: string,
    accountId: string | null = null,
    registrationId: string | null = null,
): boolean {
    return nativeModule()?.removeContext(serverId, accountId, registrationId) === true;
}

export function clearActivityNotificationContext(): void {
    nativeModule()?.clearContext();
}
