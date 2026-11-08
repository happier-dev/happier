type BrowserNotificationApi = {
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
    new (title: string, options?: NotificationOptions): Pick<Notification, 'close' | 'onclick'>;
};

function readBrowserNotificationApi(): BrowserNotificationApi | null {
    const api = (globalThis as { Notification?: unknown }).Notification;
    return typeof api === 'function' ? (api as BrowserNotificationApi) : null;
}

/**
 * Shows a browser system notification. It never prompts: a background event is no moment to ask,
 * so permission comes from `requestWebLocalNotificationPermission` on explicit user intent.
 */
export async function sendWebLocalNotification(params: Readonly<{
    title: string;
    body: string;
    tag?: string;
    onClick?: () => void;
}>): Promise<boolean> {
    const BrowserNotification = readBrowserNotificationApi();
    if (BrowserNotification?.permission !== 'granted') {
        return false;
    }

    const notification = new BrowserNotification(params.title, {
        body: params.body,
        ...(params.tag ? { tag: params.tag } : {}),
    });
    notification.onclick = () => {
        (globalThis as { focus?: () => void }).focus?.();
        notification.close();
        params.onClick?.();
    };
    return true;
}

/** Asks the browser for notification permission while it is undecided. Call it from a user gesture. */
export async function requestWebLocalNotificationPermission(): Promise<void> {
    const BrowserNotification = readBrowserNotificationApi();
    if (BrowserNotification?.permission !== 'default') {
        return;
    }
    await BrowserNotification.requestPermission();
}
