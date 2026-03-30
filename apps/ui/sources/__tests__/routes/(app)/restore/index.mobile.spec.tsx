import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    installRestoreRouteCommonModuleMocks,
    resetRestoreRouteTestState,
} from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn(async () => {});

installRestoreRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
            Platform: {
                OS: 'ios',
                select: (options: any) => options?.ios ?? options?.default ?? options?.web ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
});

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-camera', () => ({
    CameraView: Object.assign(
        (props: any) => React.createElement('CameraView', props),
        {
            isModernBarcodeScannerAvailable: true,
            launchScanner: vi.fn(),
            dismissScanner: vi.fn(async () => {}),
            onModernBarcodeScanned: vi.fn(() => ({ remove: () => {} })),
        },
    ),
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
        params: {},
    });
    return routerMock.module;
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}), isAuthenticated: false, credentials: null }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => true),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
    getActiveServerSnapshot: () => ({ serverId: 'srv', serverUrl: 'https://stack.example.test', generation: 0 }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    parsePairingDeepLink: () => null,
}));

afterEach(() => {
    resetRestoreRouteTestState();
    vi.restoreAllMocks();
    standardCleanup();
});

describe('/restore (mobile)', () => {
    it('renders a scanner-first restore UI', async () => {
        vi.resetModules();
        modalAlertSpy.mockClear();
        const { default: Screen } = await import('@/app/(app)/restore/index');

        const screen = await renderScreen(<Screen />);
        const button = screen.findByTestId('restore-show-qr-instead');
        expect(button).not.toBeNull();
    });
});
