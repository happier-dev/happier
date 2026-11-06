import { resolveProviderDeletionReminderV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { sendExpoLocalNotification } from './channels/sendExpoLocalNotification';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

/** Stop, changed native notice and deliberate lead-time edits update this existing OS schedule. */
export async function updateManagedMachineDeletionNotification(input:
    Parameters<typeof resolveProviderDeletionReminderV1>[0] & Readonly<{
        identifier: string;
        content: Pick<Parameters<typeof sendExpoLocalNotification>[0], 'title' | 'body' | 'data' | 'channelId' | 'sound'>;
    }>,
): Promise<string | null> {
    const reminder = resolveProviderDeletionReminderV1(input);
    const notifications = await loadExpoNotifications();
    await notifications.cancelScheduledNotificationAsync(input.identifier);
    if (!reminder) return null;
    return sendExpoLocalNotification({
        ...input.content, identifier: input.identifier,
        ...(reminder.due ? {} : { date: new Date(reminder.remindAt) }),
    });
}
