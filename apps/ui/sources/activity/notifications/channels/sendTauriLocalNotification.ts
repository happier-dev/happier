import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
    type DesktopNotificationInteraction,
} from './tauriNotificationPlugin';

export async function sendTauriLocalNotification(params: Readonly<{
    title: string;
    body: string;
    interaction?: DesktopNotificationInteraction;
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
        ...(params.interaction ? { interaction: params.interaction } : {}),
    });
    return true;
}
