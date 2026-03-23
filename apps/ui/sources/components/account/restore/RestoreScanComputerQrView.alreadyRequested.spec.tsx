import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { installRestoreScanComputerQrViewCommonModuleMocks } from './restoreScanComputerQrViewTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    __DEV__?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as ReactActEnvironmentGlobal).__DEV__ = true;
type ExpoGlobalShim = NonNullable<typeof globalThis.expo>;
const expoShim = {
    EventEmitter: class {} as unknown as ExpoGlobalShim['EventEmitter'],
    SharedRef: class {} as unknown as ExpoGlobalShim['SharedRef'],
    SharedObject: class {} as unknown as ExpoGlobalShim['SharedObject'],
    NativeModule: class {} as unknown as ExpoGlobalShim['NativeModule'],
    modules: {} as ExpoGlobalShim['modules'],
} satisfies Partial<ExpoGlobalShim>;
(globalThis as typeof globalThis & { expo: ExpoGlobalShim }).expo = expoShim as ExpoGlobalShim;
process.env.EXPO_OS = 'web';

vi.mock('@/dev/reactNativeStub', async () => await import('../../../dev/reactNativeStub'));
vi.mock('@/dev/testkit/mocks/reactNative', async () => await import('../../../dev/testkit/mocks/reactNative'));
vi.mock('@/dev/testkit/mocks/router', async () => await import('../../../dev/testkit/mocks/router'));
vi.mock('@/dev/testkit/mocks/modal', async () => await import('../../../dev/testkit/mocks/modal'));
vi.mock('@/dev/testkit/mocks/text', async () => await import('../../../dev/testkit/mocks/text'));
vi.mock('@/dev/testkit/mocks/unistyles', async () => await import('../../../dev/testkit/mocks/unistyles'));
vi.mock('@/theme', async () => await import('../../../theme'));

installRestoreScanComputerQrViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('../../../dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alertAsync: modalAlertAsyncSpy,
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('../../../dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    overlay: {
                        scrim: 'rgba(0,0,0,0.3)',
                        scrimStrong: 'rgba(0,0,0,0.55)',
                        text: '#fff',
                        textSecondary: 'rgba(255,255,255,0.85)',
                    },
                },
            },
        });
    },
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: vi.fn(async () => {}), refreshFromActiveServer: vi.fn(async () => {}) }),
}));

const modalAlertAsyncSpy = vi.fn(async () => {});

vi.mock('expo-constants', () => ({
    default: {
        deviceName: undefined,
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/server/url/serverUrlOverridePolicy', () => ({
    resolveEffectiveServerUrlOverride: () => null,
}));

vi.mock('@/sync/domains/server/url/serverUrlClassification', () => ({
    isLoopbackServerUrl: () => false,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s',
    parsePairingDeepLink: () => ({ pairId: 'pair_123', secret: 'secret_123', serverUrl: null }),
}));

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingRequest: vi.fn(async () => ({ ok: false, reason: 'already_requested', status: 401 })),
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

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('QrCodeScannerView', props);
    },
}));

describe('RestoreScanComputerQrView (already requested)', () => {
    it('shows a friendly error when the pairing session already has a requested device', async () => {
        vi.resetModules();
        modalAlertAsyncSpy.mockClear();
        lastScannerProps = null;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        let tree: ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = create(<RestoreScanComputerQrView />);
            });
            if (!tree) throw new Error('Expected renderer');
            expect(typeof lastScannerProps?.onScan).toBe('function');

            await act(async () => {
                await lastScannerProps.onScan('happier:///pair?v=1&pairId=pair_123&secret=secret_123');
            });

            expect(modalAlertAsyncSpy).toHaveBeenCalledWith(
                'connect.pairingAlreadyRequestedTitle',
                'connect.pairingAlreadyRequestedBody',
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
