import * as Notifications from 'expo-notifications';

export async function sendExpoLocalNotification(params: Readonly<{
    title: string;
    body: string;
    data?: Record<string, unknown>;
    categoryIdentifier?: string;
    sound?: string | null;
    channelId?: string;
}>): Promise<string> {
    const content: Parameters<typeof Notifications.scheduleNotificationAsync>[0]['content'] = {
        title: params.title,
        body: params.body,
        data: params.data,
    };
    if (params.categoryIdentifier) {
        content.categoryIdentifier = params.categoryIdentifier;
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
