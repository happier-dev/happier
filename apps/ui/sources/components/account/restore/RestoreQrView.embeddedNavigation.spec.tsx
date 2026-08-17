import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/flows/qrWait';
import type { QRAuthKeyPair } from '@/auth/flows/qrStart';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { lightTheme } from '@/theme';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

const expoRouterMock = createExpoRouterMock({
    params: {},
    router: {
        push: vi.fn(),
        back: vi.fn(),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

const restoreQrViewState = vi.hoisted(() => ({
    loginSpy: vi.fn(async () => ({ kind: 'completed' as const })),
    authQRWaitSpy: vi.fn<(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean) => Promise<AuthCredentials | null>>(async (
        _keypair,
        _onProgress,
        _shouldCancel,
    ) => await new Promise(() => {})),
    trackAccountRestoredSpy: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: restoreQrViewState.loginSpy }),
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => true),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: restoreQrViewState.authQRWaitSpy,
}));

vi.mock('@/auth/pairing/accountConnectUrl', () => ({
    buildAccountConnectDeepLink: () => 'happier:///account?v=1',
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'encoded',
}));

const modalMock = createModalModuleMock();
vi.mock('@/modal', () => modalMock.module);

const textMock = createTextModuleMock({ translate: (key: string) => key });
vi.mock('@/text', () => textMock);

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: lightTheme,
    });
});

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: (props: Record<string, unknown>) => React.createElement('QRCode', props),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: vi.fn(async () => null),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        void promise;
    },
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

vi.mock('@/utils/platform/qrScannerSupport', () => ({
    canUseCurrentDeviceQrScanner: () => true,
}));

vi.mock('@/track', () => ({
    trackAccountRestored: restoreQrViewState.trackAccountRestoredSpy,
}));

afterEach(() => {
    vi.clearAllMocks();
});

describe('RestoreQrView (embedded navigation)', () => {
    it('cancels QR restore polling after unmount', async () => {
        vi.resetModules();
        let shouldCancel: (() => boolean) | undefined;
        restoreQrViewState.authQRWaitSpy.mockImplementationOnce(async (_keypair, _onProgress, cancel) => {
            shouldCancel = cancel;
            return null;
        });

        const { RestoreQrView } = await import('./RestoreQrView');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(<RestoreQrView embedded />);
            });
            await act(async () => {});

            expect(restoreQrViewState.authQRWaitSpy).toHaveBeenCalled();
            expect(shouldCancel).toBeTypeOf('function');
            expect(shouldCancel?.()).toBe(false);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }

        expect(shouldCancel?.()).toBe(true);
    });

    it('renders an explicit scan action when an embedded scanner callback is available', async () => {
        vi.resetModules();
        const onOpenScanQr = vi.fn();
        const { RestoreQrView } = await import('./RestoreQrView');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(<RestoreQrView embedded onOpenScanQr={onOpenScanQr} />);
            });

            const button = tree.root.findByProps({ testID: 'restore-open-scan-qr' });
            expect(button).toBeTruthy();

            await act(async () => {
                button.props.onPress();
            });

            expect(onOpenScanQr).toHaveBeenCalledTimes(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('renders the restore QR code on the themed surface quiet zone', async () => {
        vi.resetModules();
        const { RestoreQrView } = await import('./RestoreQrView');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(<RestoreQrView embedded />);
            });
            await act(async () => {});

            const qrCode = tree.root.findByType('QRCode');
            expect(qrCode.props.backgroundColor).toBe(lightTheme.colors.surface.base);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('tracks a successful QR-based account restore before leaving the screen', async () => {
        vi.resetModules();
        restoreQrViewState.authQRWaitSpy.mockResolvedValueOnce({
            token: 'tok_qr',
            secret: new Uint8Array(32).fill(7),
        });
        const onBack = vi.fn();
        const { RestoreQrView } = await import('./RestoreQrView');

        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => {
                tree = renderer.create(<RestoreQrView embedded onBack={onBack} />);
            });
            await act(async () => {});

            expect(restoreQrViewState.loginSpy).toHaveBeenCalledWith('tok_qr', 'encoded');
            expect(restoreQrViewState.trackAccountRestoredSpy).toHaveBeenCalledTimes(1);
            expect(onBack).toHaveBeenCalledTimes(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
