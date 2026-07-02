import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

export async function sendExpoLocalNotification(params: Readonly<{
    title: string;
    body: string;
    data?: Record<string, unknown>;
    categoryIdentifier?: string | null;
    sound?: string | null;
    channelId?: string;
}>): Promise<string> {
    const Notifications = await loadExpoNotifications();
    const categoryIdentifier = typeof params.categoryIdentifier === 'string' && params.categoryIdentifier.trim().length > 0
        ? params.categoryIdentifier
        : undefined;
    const content: Parameters<typeof Notifications.scheduleNotificationAsync>[0]['content'] = {
        title: params.title,
        body: params.body,
        data: params.data,
    };
    if (categoryIdentifier) {
        content.categoryIdentifier = categoryIdentifier;
    }
    const sound = params.sound === undefined ? 'default' : params.sound;
    if (sound !== null) {
        content.sound = sound;
    }
    return Notifications.scheduleNotificationAsync({
        content,
        trigger: params.channelId ? { channelId: params.channelId } : null,
    });
}
