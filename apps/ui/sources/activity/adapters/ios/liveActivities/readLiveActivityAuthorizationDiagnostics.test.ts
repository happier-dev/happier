import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeModuleState = vi.hoisted(() => ({
    module: null as null | {
        getLiveActivityAuthorizationDiagnostics: () => Promise<{
            areActivitiesEnabled?: boolean;
            frequentPushesEnabled?: boolean;
        }>;
    },
}));

const expoWidgetsState = vi.hoisted(() => ({
    getDiagnostics: undefined as undefined | (() => Promise<{
        areActivitiesEnabled?: boolean;
        frequentPushesEnabled?: boolean;
    }>),
}));

vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => nativeModuleState.module,
}));

vi.mock('expo-widgets', () => ({
    get getLiveActivityAuthorizationDiagnostics() {
        return expoWidgetsState.getDiagnostics;
    },
}));

async function loadAuthorizationDiagnosticsModule() {
    return import('./readLiveActivityAuthorizationDiagnostics').catch(() => null);
}

describe('readLiveActivityAuthorizationDiagnostics', () => {
    afterEach(() => {
        nativeModuleState.module = null;
        expoWidgetsState.getDiagnostics = undefined;
        vi.resetModules();
    });

    it('reports unavailable diagnostics when neither expo-widgets nor the native shim exposes authorization state', async () => {
        const diagnosticsModule = await loadAuthorizationDiagnosticsModule();
        expect(diagnosticsModule).not.toBeNull();
        if (!diagnosticsModule) return;

        await expect(diagnosticsModule.readLiveActivityAuthorizationDiagnostics()).resolves.toEqual({
            source: 'unavailable',
            activities: 'unavailable',
            frequentUpdates: 'unavailable',
        });
    });

    it('uses an expo-widgets authorization API when a future bridge exposes it', async () => {
        expoWidgetsState.getDiagnostics = async () => ({
            areActivitiesEnabled: false,
            frequentPushesEnabled: true,
        });

        const diagnosticsModule = await loadAuthorizationDiagnosticsModule();
        expect(diagnosticsModule).not.toBeNull();
        if (!diagnosticsModule) return;

        await expect(diagnosticsModule.readLiveActivityAuthorizationDiagnostics()).resolves.toEqual({
            source: 'expo-widgets',
            activities: 'disabled',
            frequentUpdates: 'enabled',
        });
    });

    it('falls back to the native authorization shim when expo-widgets does not expose diagnostics', async () => {
        nativeModuleState.module = {
            getLiveActivityAuthorizationDiagnostics: async () => ({
                areActivitiesEnabled: true,
                frequentPushesEnabled: false,
            }),
        };

        const diagnosticsModule = await loadAuthorizationDiagnosticsModule();
        expect(diagnosticsModule).not.toBeNull();
        if (!diagnosticsModule) return;

        await expect(diagnosticsModule.readLiveActivityAuthorizationDiagnostics()).resolves.toEqual({
            source: 'native-shim',
            activities: 'enabled',
            frequentUpdates: 'disabled',
        });
    });
});
