import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from './tauriNotificationPlugin';

export async function sendTauriLocalNotification(params: Readonly<{
    title: string;
    body: string;
}>): Promise<boolean> {
    let granted = await isPermissionGranted();
    if (!granted) {
        granted = (await requestPermission()) === 'granted';
    }
    if (!granted) {
        return false;
    }

    await sendNotification({
        title: params.title,
        body: params.body,
    });
    return true;
}
