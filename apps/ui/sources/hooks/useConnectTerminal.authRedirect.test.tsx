import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const setPendingTerminalConnectSpy = vi.fn();
const modalAlertSpy = vi.fn();

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
}));

vi.mock('expo-router', () => ({
    router: { replace: routerReplaceSpy },
}));

vi.mock('expo-camera', () => ({
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: vi.fn(),
        launchScanner: vi.fn(),
        dismissScanner: vi.fn(),
    },
}));

vi.mock('expo-updates', () => ({
    reloadAsync: vi.fn(async () => {}),
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/hooks/useCheckCameraPermissions', () => ({
    useCheckScannerPermissions: () => vi.fn(async () => true),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: any[]) => modalAlertSpy(...args),
        confirm: vi.fn(async () => true),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://api.happier.dev',
    setServerUrl: vi.fn(),
}));

vi.mock('@/sync/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: (...args: any[]) => setPendingTerminalConnectSpy(...args),
    getPendingTerminalConnect: () => null,
    clearPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/auth/authApprove', () => ({
    authApprove: vi.fn(),
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('@/encryption/libsodium', () => ({
    encryptBox: vi.fn(() => new Uint8Array([4, 5, 6])),
}));

vi.mock('@/sync/sync', () => ({
    sync: { encryption: { contentDataKey: new Uint8Array([9, 9, 9]) } },
}));

describe('useConnectTerminal unauthenticated flow', () => {
    it('stores pending connect intent and routes to sign-in', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl('happier://terminal?key=abc123&server=https%3A%2F%2Fapi.happier.dev');
        });

        expect(result).toBe(false);
        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://api.happier.dev',
        });
        expect(modalAlertSpy).toHaveBeenCalledWith('terminal.connectTerminal', 'modals.pleaseSignInFirst', [
            { text: 'common.continue' },
        ]);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });
});
