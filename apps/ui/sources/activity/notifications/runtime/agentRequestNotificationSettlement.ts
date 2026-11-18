import type { ParsedNotificationTap } from '../notificationRouting';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

/** Exact identity required by both passive reconciliation and confirmed actions. */
export function readAgentRequestNotificationIdentity(data: unknown) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const record = data as Record<string, unknown>;
    const { kind, accountId, serverUrl, sessionId, requestId, occurrenceId } = record;
    if ((kind !== 'permission' && kind !== 'user_action')
        || typeof accountId !== 'string' || !accountId
        || typeof serverUrl !== 'string' || !createServerUrlComparableKey(serverUrl)
        || typeof sessionId !== 'string' || !sessionId
        || typeof requestId !== 'string' || !requestId
        || typeof occurrenceId !== 'string' || !occurrenceId) return null;
    return { kind, accountId, serverUrl, sessionId, requestId, occurrenceId };
}

/** The CLI acknowledgement proves settlement even with no foreground session cache. */
export async function dismissConfirmedAgentRequestNotification(parsed: ParsedNotificationTap): Promise<void> {
    const response = parsed.questionAction ?? parsed.permissionAction;
    if (!response?.occurrenceId || !parsed.accountId || !parsed.serverUrl) return;
    const notifications = await loadExpoNotifications();
    const presented = await notifications.getPresentedNotificationsAsync();
    const serverKey = createServerUrlComparableKey(parsed.serverUrl);
    for (const notification of presented) {
        const identity = readAgentRequestNotificationIdentity(notification.request.content.data);
        if (!identity || identity.accountId !== parsed.accountId
            || createServerUrlComparableKey(identity.serverUrl) !== serverKey
            || identity.sessionId !== response.sessionId || identity.requestId !== response.requestId
            || identity.occurrenceId !== response.occurrenceId) continue;
        // Inspect the current OS inventory, rather than blindly dismissing the
        // clicked identifier: it may now refer to a newer request occurrence.
        await notifications.dismissNotificationAsync(notification.request.identifier);
    }
}
