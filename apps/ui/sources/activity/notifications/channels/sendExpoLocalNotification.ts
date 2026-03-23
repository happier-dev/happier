import * as Notifications from 'expo-notifications';

export async function sendExpoLocalNotification(params: Readonly<{
    title: string;
    body: string;
    data?: Record<string, unknown>;
    categoryIdentifier?: string;
}>): Promise<string> {
    return Notifications.scheduleNotificationAsync({
        content: {
            title: params.title,
            body: params.body,
            data: params.data,
            categoryIdentifier: params.categoryIdentifier,
            sound: 'default',
        },
        trigger: null,
    });
}
