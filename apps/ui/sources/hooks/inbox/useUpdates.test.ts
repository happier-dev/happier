import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHookAndCollectValues, flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';

vi.mock('expo-updates', () => ({
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
    fetchUpdateAsync: vi.fn(async () => {}),
    reloadAsync: vi.fn(async () => {}),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

async function flushMore() {
    await flushHookEffects(10);
}

describe('useUpdates (OTA gating)', () => {
    it('does not check for OTA updates when updates.ota is disabled', async () => {
        vi.resetModules();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    features: {
                        updates: { ota: { enabled: false } },
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: false },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false, configured: false, provider: null },
                        social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
                        oauth: { providers: {} },
                        auth: {
                            signup: { methods: [] },
                            login: { requiredProviders: [] },
                            recovery: { providerReset: { enabled: false, providers: [] } },
                            ui: {
                                autoRedirect: { enabled: false, providerId: null },
                                recoveryKeyReminder: { enabled: false },
                            },
                            providers: {},
                            misconfig: [],
                        },
                    },
                }),
            })) as any,
        );

        const { useUpdates } = await import('./useUpdates');
        await renderHookAndCollectValues(() => useUpdates());
        await flushMore();

        const Updates = await import('expo-updates');
        expect((Updates as any).checkForUpdateAsync).not.toHaveBeenCalled();
    });

    it('checks for OTA updates when updates.ota is enabled', async () => {
        vi.resetModules();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    features: {
                        updates: { ota: { enabled: true } },
                        sharing: {
                            session: { enabled: true },
                            public: { enabled: false },
                            contentKeys: { enabled: true },
                            pendingQueueV2: { enabled: false },
                        },
                        voice: { enabled: false, configured: false, provider: null },
                        social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
                        oauth: { providers: {} },
                        auth: {
                            signup: { methods: [] },
                            login: { requiredProviders: [] },
                            recovery: { providerReset: { enabled: false, providers: [] } },
                            ui: {
                                autoRedirect: { enabled: false, providerId: null },
                                recoveryKeyReminder: { enabled: false },
                            },
                            providers: {},
                            misconfig: [],
                        },
                    },
                }),
            })) as any,
        );

        const { useUpdates } = await import('./useUpdates');
        await renderHookAndCollectValues(() => useUpdates());
        await flushMore();

        const Updates = await import('expo-updates');
        expect((Updates as any).checkForUpdateAsync).toHaveBeenCalledTimes(1);
    });
});

