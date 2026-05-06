import {
    isPermissionGranted as pluginIsPermissionGranted,
    requestPermission as pluginRequestPermission,
    sendNotification as pluginSendNotification,
} from '@tauri-apps/plugin-notification';

type NotificationPermission = Awaited<ReturnType<typeof pluginRequestPermission>>;

type TauriNotificationModule = {
    isPermissionGranted: () => Promise<boolean>;
    requestPermission: () => Promise<NotificationPermission>;
    sendNotification: (payload: { title: string; body: string }) => void;
};

const plugin: TauriNotificationModule = {
    isPermissionGranted: pluginIsPermissionGranted,
    requestPermission: pluginRequestPermission,
    sendNotification: pluginSendNotification,
};

export async function isPermissionGranted(): Promise<boolean> {
    return await plugin.isPermissionGranted();
}

export async function requestPermission(): Promise<NotificationPermission> {
    return await plugin.requestPermission();
}

export async function sendNotification(payload: { title: string; body: string }): Promise<void> {
    plugin.sendNotification(payload);
}
