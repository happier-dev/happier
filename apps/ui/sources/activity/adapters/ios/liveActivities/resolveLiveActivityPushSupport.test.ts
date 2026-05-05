import { describe, expect, it } from 'vitest';

async function loadModule() {
    return import('./resolveLiveActivityPushSupport').catch(() => null);
}

describe('resolveLiveActivityPushSupport', () => {
    it('reports local-only support when the expo-widgets static push flag is absent', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const support = mod.resolveLiveActivityPushSupport({
            expoConfig: {
                plugins: [
                    ['expo-widgets', { widgets: [] }],
                ],
            },
            tokenApisAvailable: true,
        });

        expect(support.canRegisterRemoteTargets).toBe(false);
        expect(support.expoWidgetsPushNotificationsEnabled).toBe(false);
        expect(support.reasons).toContain('expo_widgets_push_notifications_disabled');
    });

    it('allows remote target registration only when static push support and token APIs are available', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const support = mod.resolveLiveActivityPushSupport({
            expoConfig: {
                plugins: [
                    ['expo-widgets', { enablePushNotifications: true, widgets: [] }],
                ],
            },
            tokenApisAvailable: true,
        });

        expect(support).toMatchObject({
            canRegisterRemoteTargets: true,
            expoWidgetsPushNotificationsEnabled: true,
            tokenApisAvailable: true,
            reasons: [],
        });
    });

    it('reads the runtime extra push-support flag when plugin config is unavailable at runtime', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const support = mod.resolveLiveActivityPushSupport({
            expoConfig: {
                extra: {
                    app: {
                        iosLiveActivityPushNotificationsEnabled: true,
                    },
                },
            },
            tokenApisAvailable: true,
        });

        expect(support.canRegisterRemoteTargets).toBe(true);
        expect(support.expoWidgetsPushNotificationsEnabled).toBe(true);
        expect(support.reasons).toEqual([]);
    });

    it('keeps diagnostics honest when token APIs are missing', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const support = mod.resolveLiveActivityPushSupport({
            expoConfig: {
                plugins: [
                    ['expo-widgets', { enablePushNotifications: true, widgets: [] }],
                ],
            },
            tokenApisAvailable: false,
        });

        expect(support.canRegisterRemoteTargets).toBe(false);
        expect(support.reasons).toContain('expo_widgets_token_api_missing');
    });
});
