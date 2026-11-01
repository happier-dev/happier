import '@expo/metro-runtime';

declare const require: (id: string) => unknown;

if (typeof window !== 'undefined') {
    try {
        const mod = require('./sources/dev/webHmrOptOut/webHmrOptOut');
        if (typeof mod === 'object' && mod !== null && 'installWebHmrOptOutForWebTab' in mod) {
            const install = (mod as { installWebHmrOptOutForWebTab?: unknown }).installWebHmrOptOutForWebTab;
            if (typeof install === 'function') {
                install({
                    url: new URL(window.location.href),
                    sessionStorage: window.sessionStorage,
                    history: window.history,
                });
            }
        }
    } catch {
        // ignore
    }

    try {
        if (typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== 'undefined' && (globalThis as unknown as { __DEV__?: boolean }).__DEV__) {
            const mod = require('./sources/desktop/mcp/installTauriMcpWebviewDriverScripts');
            if (typeof mod === 'object' && mod !== null && 'installTauriMcpWebviewDriverScripts' in mod) {
                const install = (mod as { installTauriMcpWebviewDriverScripts?: unknown }).installTauriMcpWebviewDriverScripts;
                if (typeof install === 'function') {
                    install();
                }
            }
        }
    } catch {
        // ignore
    }
}

require('./sources/unistyles');
// Keep this optional-native boundary structural. A typeof import of either
// implementation pulls Expo/React Native ambient globals into the entry point
// ahead of Node's test declarations, changing the app-wide timer overloads.
type NotificationBackgroundTaskModule = { registerNotificationBackgroundTask(): Promise<boolean> };
type NotificationBackgroundTaskBootstrap = {
    initializeNotificationBackgroundTask(platform: string, load: () => NotificationBackgroundTaskModule): Promise<boolean>;
};
try {
    const platform = require('react-native') as { Platform?: { OS?: string } };
    const platformOS = platform.Platform?.OS;
    if (platformOS === 'android' || platformOS === 'ios') {
        const { initializeNotificationBackgroundTask } = require('./sources/activity/notifications/runtime/notificationBackgroundTaskState') as NotificationBackgroundTaskBootstrap;
        void initializeNotificationBackgroundTask(platformOS, () =>
            require('./sources/activity/notifications/runtime/notificationBackgroundTask') as NotificationBackgroundTaskModule);
    }
} catch {
    console.warn('[notifications] Background action bootstrap unavailable; using foreground actions');
}
require('expo-router/entry');
