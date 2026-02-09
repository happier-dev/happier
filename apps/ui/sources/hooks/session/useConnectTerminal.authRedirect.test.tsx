import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const setPendingTerminalConnectSpy = vi.fn();
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const upsertActivateAndSwitchServerSpy = vi.fn(async () => true);

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

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
    },
}));

vi.mock('@/hooks/ui/useCheckCameraPermissions', () => ({
    useCheckScannerPermissions: () => vi.fn(async () => true),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: any[]) => modalAlertSpy(...args),
        confirm: (...args: any[]) => modalConfirmSpy(...args),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: (...args: any[]) => upsertActivateAndSwitchServerSpy(...args),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: (...args: any[]) => setPendingTerminalConnectSpy(...args),
    getPendingTerminalConnect: () => null,
    clearPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/auth/flows/approve', () => ({
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

    it('auto-switches server without confirmation prompt before redirecting unauthenticated users', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();

        vi.doMock('@/sync/domains/server/serverProfiles', () => ({
            getActiveServerUrl: () => 'https://api.happier.dev',
        }));

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
            result = await hookApi!.processAuthUrl('happier://terminal?key=abc123&server=https%3A%2F%2Fstack.example.test');
        });

        expect(result).toBe(false);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledTimes(1);
        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                serverUrl: 'https://stack.example.test',
                source: 'url',
                scope: 'device',
            }),
        );
        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });
});
