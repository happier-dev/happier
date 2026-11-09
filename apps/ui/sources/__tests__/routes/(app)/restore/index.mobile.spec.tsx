import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    installRestoreRouteCommonModuleMocks,
} from './restoreRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn(async (
    _title: string,
    _message: string,
    buttons?: ReadonlyArray<Readonly<{ onPress?: () => void }>>,
) => {
    buttons?.[0]?.onPress?.();
});
const restoreMobileRouteState = vi.hoisted(() => ({
    params: {} as Readonly<Record<string, string>>,
    backSpy: vi.fn(),
    replaceSpy: vi.fn(),
}));

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
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: restoreMobileRouteState.backSpy, push: vi.fn(), replace: restoreMobileRouteState.replaceSpy },
            params: () => restoreMobileRouteState.params,
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

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => {
    const signedOut = { login: vi.fn(async () => {}), isAuthenticated: false, credentials: null };
    return { useAuth: () => signedOut, useOptionalAuth: () => signedOut };
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: vi.fn(async () => null),
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal, {
        profiles: [{ id: 'srv', serverUrl: 'https://stack.example.test' }],
        overrides: {
            getActiveServerUrl: () => 'https://stack.example.test',
            getActiveServerSnapshot: () => ({ serverId: 'srv', serverUrl: 'https://stack.example.test', generation: 0 }),
            subscribeActiveServer: () => () => {},
        },
    });
});

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/pairing/pairingUrl', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/pairing/pairingUrl')>(),
    classifyLegacyPairingDeepLink: () => null,
}));

const { default: Screen } = await import('@/app/(app)/restore/index');

afterEach(() => {
    restoreMobileRouteState.params = {};
    restoreMobileRouteState.backSpy.mockClear();
    restoreMobileRouteState.replaceSpy.mockReset();
    vi.restoreAllMocks();
    standardCleanup();
});

describe('/restore (mobile)', () => {
    it('renders scanner-first without offering targetless reverse QR', async () => {
        modalAlertSpy.mockClear();

        const screen = await renderScreen(<Screen />);
        expect(screen.findByTestId('restore-enter-pairing-link')).not.toBeNull();
        expect(screen.findByTestId('restore-show-qr-instead')).toBeNull();
    });

    it('shows canonical update-required guidance from a secret-free native-intent marker', async () => {
        restoreMobileRouteState.params = { legacyPairingUpdateRequired: '1' };
        restoreMobileRouteState.replaceSpy.mockImplementation((path: unknown) => {
            if (path === '/restore') restoreMobileRouteState.params = {};
        });
        modalAlertSpy.mockClear();

        const screen = await renderScreen(<Screen />);
        expect(screen.findByTestId('legacy-pairing-update-required-route')).not.toBeNull();
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'connect.updateRequiredTitle',
            'connect.legacyPairingUpdateRequiredBody',
            [
                expect.objectContaining({ text: 'connect.scanNewQr' }),
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
            ],
        );
        expect(screen.findByTestId('restore-show-qr-instead')).toBeNull();
        expect(restoreMobileRouteState.replaceSpy).toHaveBeenCalledWith('/restore');
        expect(restoreMobileRouteState.replaceSpy.mock.invocationCallOrder[0]).toBeLessThan(
            modalAlertSpy.mock.invocationCallOrder[0]!,
        );
        expect(restoreMobileRouteState.backSpy).not.toHaveBeenCalled();
        expect(JSON.stringify(modalAlertSpy.mock.calls)).not.toContain('stack.example.test');

        await screen.unmount();
        const remounted = await renderScreen(<Screen />);
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        expect(remounted.findByTestId('restore-show-qr-instead')).toBeNull();
    });
});
