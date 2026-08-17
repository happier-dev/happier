import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AuthCredentials } from '@/auth/flows/qrWait';
import type { QRAuthKeyPair } from '@/auth/flows/qrStart';
import type { PairingRequestResult } from '@/sync/api/account/apiPairingAuth';

type PairingRequestParams = {
    pairId: string;
    secret: string;
    publicKey: string;
    deviceLabel?: string;
};
import {
    installRestoreScanComputerQrViewCommonModuleMocks,
    resetRestoreScanComputerQrViewCommonModuleMockState,
} from './restoreScanComputerQrViewTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const navigationState = vi.hoisted(() => ({
    isFocused: true,
}));
const modalAlertSpy = vi.hoisted(() => vi.fn(async (
    _title?: string,
    _message?: string,
    _buttons?: Array<{ text?: string; onPress?: () => void }>,
) => {}));

const restoreScanSuccessState = vi.hoisted(() => ({
    loginSpy: vi.fn(async () => ({ kind: 'completed' as const })),
    trackAccountRestoredSpy: vi.fn(),
    pairingRequestSpy: vi.fn<(params: PairingRequestParams) => Promise<PairingRequestResult>>(async (_params) => ({
        ok: false,
        reason: 'not_found',
        status: 404,
    })),
    authQRWaitSpy: vi.fn<(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean) => Promise<AuthCredentials | null>>(async (_keypair) => null),
    parsePairingDeepLinkSpy: vi.fn<(url: string) => { pairId: string; secret: string; serverUrl: string | null } | null>(
        (_url) => null,
    ),
}));

installRestoreScanComputerQrViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alertAsync: modalAlertSpy } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
        });
    },
    reactNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return {
            ...createReactNavigationNativeMock(),
            useIsFocused: () => navigationState.isFocused,
        };
    },
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ login: restoreScanSuccessState.loginSpy, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/api/account/apiPairingAuth', () => ({
    pairingRequest: (params: PairingRequestParams) => restoreScanSuccessState.pairingRequestSpy(params),
}));

vi.mock('@/auth/flows/qrStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) }),
    authQRStart: vi.fn(async () => true),
}));

vi.mock('@/auth/flows/qrWait', () => ({
    authQRWait: restoreScanSuccessState.authQRWaitSpy,
}));

vi.mock('@/encryption/base64', () => ({
    encodeBase64: () => 'x',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (s: string) => s,
    upsertActivateAndSwitchServer: vi.fn(async () => {}),
}));

vi.mock('@/auth/pairing/pairingUrl', () => ({
    buildPairingDeepLink: () => 'happier:///pair?v=1&pairId=p&secret=s',
    parsePairingDeepLink: (url: string) => restoreScanSuccessState.parsePairingDeepLinkSpy(url),
}));

let lastScannerProps: any = null;
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: any) => {
        lastScannerProps = props;
        return React.createElement('div', { 'data-testid': 'QrCodeScannerView' }, props.footer ?? null);
    },
}));

vi.mock('@/track', () => ({
    trackAccountRestored: restoreScanSuccessState.trackAccountRestoredSpy,
}));

describe('RestoreScanComputerQrView (web phone)', () => {
    beforeEach(() => {
        vi.resetModules();
        resetRestoreScanComputerQrViewCommonModuleMockState();
        navigationState.isFocused = true;
        lastScannerProps = null;
        modalAlertSpy.mockClear();
    });

    it('renders the QR scanner in idle state on web', async () => {
        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        const screen = await renderScreen(<RestoreScanComputerQrView />);

        expect(screen.findByProps({ 'data-testid': 'QrCodeScannerView' })).toBeTruthy();
        expect(screen.findByTestId('restore-open-manual')).toBeTruthy();
        expect(screen.findByTestId('restore-show-qr-instead')).toBeTruthy();
        expect(lastScannerProps?.testIDPrefix).toBe('restore-scan');
        expect(lastScannerProps?.active).toBe(true);
    });

    it('marks the QR scanner inactive when the restore route is covered by another screen', async () => {
        navigationState.isFocused = false;

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        await renderScreen(<RestoreScanComputerQrView />);

        expect(lastScannerProps?.active).toBe(false);
    });

    it('routes an account-connect QR through the embedded restore owner instead of treating it as invalid', async () => {
        modalAlertSpy.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button: { text?: string }) => button.text === 'connect.showQrInstead')?.onPress?.();
        });
        const onShowQrInstead = vi.fn();
        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        await renderScreen(<RestoreScanComputerQrView embedded onShowQrInstead={onShowQrInstead} />);
        await act(async () => {
            await lastScannerProps?.onScan('happier:///account?abc123');
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'connect.restoreAccount',
            'connect.restoreQrInstructions',
            expect.any(Array),
        );
        expect(onShowQrInstead).toHaveBeenCalledOnce();
        expect(restoreScanSuccessState.parsePairingDeepLinkSpy).not.toHaveBeenCalled();
    });

    it('tracks account restoration after a successful computer-QR restore flow', async () => {
        vi.resetModules();
        resetRestoreScanComputerQrViewCommonModuleMockState();
        lastScannerProps = null;
        restoreScanSuccessState.loginSpy.mockReset();
        restoreScanSuccessState.trackAccountRestoredSpy.mockReset();
        restoreScanSuccessState.pairingRequestSpy.mockResolvedValueOnce({
            ok: true,
            data: { state: 'requested', confirmCode: '1234' },
        });
        restoreScanSuccessState.authQRWaitSpy.mockResolvedValueOnce({
            token: 'tok_pair',
            secret: new Uint8Array(32).fill(4),
        });
        restoreScanSuccessState.parsePairingDeepLinkSpy.mockReturnValueOnce({
            pairId: 'p',
            secret: 's',
            serverUrl: null,
        });

        const { RestoreScanComputerQrView } = await import('./RestoreScanComputerQrView');

        await renderScreen(<RestoreScanComputerQrView />);
        await act(async () => {
            await lastScannerProps.onScan('happier:///pair?v=1&pairId=p&secret=s');
        });

        expect(restoreScanSuccessState.loginSpy).toHaveBeenCalledWith('tok_pair', 'x');
        expect(restoreScanSuccessState.trackAccountRestoredSpy).toHaveBeenCalledTimes(1);
    });
});
