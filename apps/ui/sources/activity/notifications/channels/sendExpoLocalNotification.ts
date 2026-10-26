import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { Platform } from 'react-native';

export async function sendExpoLocalNotification(params: Readonly<{
    title: string;
    body: string;
    data?: Record<string, unknown>;
    categoryIdentifier?: string | null;
    channelId?: string | null;
}>): Promise<string> {
    const Notifications = await loadExpoNotifications();
    const categoryIdentifier = typeof params.categoryIdentifier === 'string' && params.categoryIdentifier.trim().length > 0
        ? params.categoryIdentifier
        : undefined;
    return Notifications.scheduleNotificationAsync({
        content: {
            title: params.title,
            body: params.body,
            data: params.data,
            ...(categoryIdentifier ? { categoryIdentifier } : {}),
            sound: 'default',
        },
        trigger: Platform.OS === 'android' && params.channelId?.trim() ? { channelId: params.channelId } : null,
    });
}
