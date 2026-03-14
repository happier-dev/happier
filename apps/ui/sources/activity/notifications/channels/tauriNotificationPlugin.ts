type NotificationPermission = 'granted' | 'denied' | 'prompt';

type TauriNotificationModule = {
    isPermissionGranted: () => Promise<boolean>;
    requestPermission: () => Promise<NotificationPermission>;
    sendNotification: (payload: { title: string; body: string }) => void;
};

let cached: TauriNotificationModule | null = null;

async function loadTauriNotificationModule(): Promise<TauriNotificationModule | null> {
    if (cached) return cached;

    // Keep the module specifier non-literal so TypeScript does not require
    // this optional dependency in non-Tauri builds.
    const moduleName: string = '@tauri-apps/plugin-notification';
    try {
        const mod = await import(moduleName) as unknown as Partial<TauriNotificationModule>;
        if (
            typeof mod.isPermissionGranted === 'function'
            && typeof mod.requestPermission === 'function'
            && typeof mod.sendNotification === 'function'
        ) {
            cached = mod as TauriNotificationModule;
            return cached;
        }
    } catch {
        // ignore
    }
    return null;
}

export async function isPermissionGranted(): Promise<boolean> {
    const mod = await loadTauriNotificationModule();
    return mod ? await mod.isPermissionGranted() : false;
}

export async function requestPermission(): Promise<NotificationPermission> {
    const mod = await loadTauriNotificationModule();
    return mod ? await mod.requestPermission() : 'denied';
}

export async function sendNotification(payload: { title: string; body: string }): Promise<void> {
    const mod = await loadTauriNotificationModule();
    if (!mod) return;
    mod.sendNotification(payload);
}
