import { resolveProviderDeletionReminderV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import { sendExpoLocalNotification } from './channels/sendExpoLocalNotification';
import { sendWebLocalNotification } from './channels/sendWebLocalNotification';
import { sendTauriLocalNotification } from './channels/sendTauriLocalNotification';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { desktopHostKind } from '@/utils/platform/desktopHost';

type DeletionNotificationContent = Pick<Parameters<typeof sendExpoLocalNotification>[0], 'title' | 'body' | 'data' | 'channelId' | 'sound'>;

/** Native keeps an OS schedule; document hosts hold the deadline while their runtime is mounted. */
export async function updateManagedMachineDeletionNotification(input:
    Parameters<typeof resolveProviderDeletionReminderV1>[0] & Readonly<{
        identifier: string;
        content: DeletionNotificationContent | ((reminder: NonNullable<ReturnType<typeof resolveProviderDeletionReminderV1>>) => DeletionNotificationContent);
    }>,
    documentDelivery?: Readonly<{ channel: 'web' | 'desktop'; signal: AbortSignal }>,
): Promise<string | null> {
    const reminder = resolveProviderDeletionReminderV1(input);
    if (documentDelivery) {
        const { signal } = documentDelivery;
        if (!reminder || signal.aborted) return null;
        if (!reminder.due) {
            const reachedDeadline = await new Promise<boolean>(resolve => {
                const cancel = armDeadlineTimer(reminder.remindAt, () => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(true);
                });
                const onAbort = () => { cancel(); resolve(false); };
                signal.addEventListener('abort', onAbort, { once: true });
            });
            if (!reachedDeadline || signal.aborted) return null;
        }
        const content = typeof input.content === 'function' ? input.content(reminder) : input.content;
        const delivered = documentDelivery.channel === 'web'
            ? await sendWebLocalNotification({ ...content, tag: input.identifier })
            : await sendTauriLocalNotification({ ...content,
                ...(desktopHostKind() === 'tauri' ? { interaction: {
                    identifier: input.identifier, data: content.data ?? {}, actions: [],
                } } : {}),
            });
        return delivered ? input.identifier : null;
    }
    const notifications = await loadExpoNotifications();
    await notifications.cancelScheduledNotificationAsync(input.identifier);
    if (!reminder) return null;
    return sendExpoLocalNotification({
        ...(typeof input.content === 'function' ? input.content(reminder) : input.content), identifier: input.identifier,
        ...(reminder.due ? {} : { date: new Date(reminder.remindAt) }),
    });
}
