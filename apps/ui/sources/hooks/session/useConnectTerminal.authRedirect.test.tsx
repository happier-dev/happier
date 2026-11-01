vi.mock('@/sync/http/client', () => ({ serverFetch: async () => new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 }) }));
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    openTerminalProvisioningV2Payload,
    openTerminalProvisioningV3Payload,
} from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const setPendingTerminalConnectSpy = vi.fn((_pending: {
    publicKeyB64Url: string;
    serverUrl: string;
    pairing?: {
        secretB64Url: string;
        createdAtMs: number;
        expiresAtMs: number;
    };
}) => {});
const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
const modalAlertAsyncSpy = vi.fn(async (...args: unknown[]) => {
    modalAlertSpy(...args);
});
const modalConfirmSpy = vi.fn(async () => true);
const upsertActivateAndSwitchServerSpy = vi.fn(async (_params: { serverUrl: string; source: string; scope: string }) => true);
const authApproveSpy = vi.fn();

let authCredentials: any = null;
let storedCredentialsOverride: any | undefined = undefined;
let contentPrivateKey = new Uint8Array([7, 7, 7]);
let contentPublicKey = new Uint8Array([9, 9, 9]);
let activeServerUrl = 'https://api.happier.dev';
let activeShareableServerUrl: string | null = null;

installSessionHooksCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            Dimensions: {
                get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { replace: routerReplaceSpy },
        });
        return expoRouterMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                alertAsync: modalAlertAsyncSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('expo-camera', () => ({
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: vi.fn(),
        launchScanner: vi.fn(),
        dismissScanner: vi.fn(),
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentials: vi.fn(async () => storedCredentialsOverride === undefined ? authCredentials : storedCredentialsOverride),
        },
    };
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    getActiveServerSnapshot: () => ({
        serverId: 'active-server',
        serverUrl: activeServerUrl,
        activeShareableServerUrl,
        activeLocalRelayUrl: null,
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerSpy,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: setPendingTerminalConnectSpy,
    getPendingTerminalConnect: () => null,
    clearPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/auth/flows/approve', () => ({
    authApprove: authApproveSpy,
}));

vi.mock('@/encryption/base64', () => ({
    decodeBase64: vi.fn((value: string, variant?: string) => {
        const normalized = variant === 'base64url' ? value : value;
        return new Uint8Array(Buffer.from(normalized, 'base64url'));
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { encryption: { contentDataKey: contentPublicKey, getContentPrivateKey: () => contentPrivateKey } },
}));

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = {
        getState: () => ({ settings: { terminalConnectLegacySecretExportEnabled: false } }),
    };
    return { storage, getStorage: () => storage };
});

function buildTerminalConnectUrl(params: Readonly<{
    terminalPublicKey: Uint8Array;
    serverUrl?: string;
    pairingSecret?: Uint8Array;
    createdAtMs?: number;
    expiresAtMs?: number;
}>): string {
    const publicKeyB64Url = Buffer.from(params.terminalPublicKey).toString('base64url');
    const server = encodeURIComponent(params.serverUrl ?? 'https://api.happier.dev');
    const pairing =
        params.pairingSecret
        && params.createdAtMs !== undefined
        && params.expiresAtMs !== undefined
            ? `&pairingSecret=${Buffer.from(params.pairingSecret).toString('base64url')}`
                + `&createdAt=${params.createdAtMs}`
                + `&expiresAt=${params.expiresAtMs}`
            : '';
    return `happier://terminal?key=${publicKeyB64Url}&server=${server}${pairing}`;
}

function createDataKeyCredentials(params: Readonly<{ token: string; machineKeyByte: number; publicKeyByte?: number }>) {
    return {
        token: params.token,
        encryption: {
            publicKey: Buffer.from(new Uint8Array(32).fill(params.publicKeyByte ?? params.machineKeyByte + 1)).toString('base64'),
            machineKey: Buffer.from(new Uint8Array(32).fill(params.machineKeyByte)).toString('base64'),
        },
    } as const;
}

function createLegacyCredentials(params: Readonly<{ token: string; secretByte: number }>) {
    return {
        token: params.token,
        secret: Buffer.from(new Uint8Array(32).fill(params.secretByte)).toString('base64url'),
    } as const;
}

afterEach(() => {
    storedCredentialsOverride = undefined;
    activeShareableServerUrl = null;
});

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

        await renderScreen(React.createElement(Probe));

        const pairingSecret = new Uint8Array(32).fill(11);
        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey: new Uint8Array([1, 2, 3]),
                pairingSecret,
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
            }));
        });

        expect(result).toBe(false);
        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith({
            publicKeyB64Url: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64url'),
            serverUrl: 'https://api.happier.dev',
            pairing: {
                secretB64Url: Buffer.from(pairingSecret).toString('base64url'),
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
            },
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
        activeServerUrl = 'https://api.happier.dev';

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

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

    it('does not switch to a loopback server URL from the link when the active server is already non-loopback', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();

        authCredentials = null;
        activeServerUrl = 'https://lan.example.test:53288';

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl('happier://terminal?key=abc123&server=http%3A%2F%2Flocalhost%3A53288');
        });

        expect(result).toBe(false);
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://lan.example.test:53288',
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });

    it('does not switch to a different loopback server URL when the active server is already loopback', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();

        authCredentials = null;
        activeServerUrl = 'http://127.0.0.1:43005';

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl('happier://terminal?key=abc123&server=http%3A%2F%2F127.0.0.1%3A3005');
        });

        expect(result).toBe(false);
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'http://127.0.0.1:43005',
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });

    it('allows loopback server overrides when terminal connect explicitly opts in', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();

        authCredentials = null;
        activeServerUrl = 'http://127.0.0.1:43005';

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ allowLoopbackServerOverride: true });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl('happier://terminal?key=abc123&server=http%3A%2F%2F127.0.0.1%3A3005');
        });

        expect(result).toBe(false);
        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                serverUrl: 'http://127.0.0.1:3005',
                source: 'url',
                scope: 'device',
            }),
        );
        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'http://127.0.0.1:3005',
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });

    it('uses the content private key in the v2 response bundle for dataKey credentials', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();

        authCredentials = createDataKeyCredentials({ token: 'token-1', machineKeyByte: 7 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({ terminalPublicKey }));
        });

        expect(result).toBe(true);
        expect(authApproveSpy).toHaveBeenCalled();
        const approveArgs = authApproveSpy.mock.calls[0] as unknown[] | undefined;
        const responseV2 = approveArgs?.[3] as Uint8Array | undefined;
        expect(responseV2).toBeDefined();
        const opened = openTerminalProvisioningV2Payload({ payload: responseV2!, recipientSecretKeyOrSeed: terminalSecretKey });
        expect(opened).not.toBeNull();
        expect(Array.from(opened!)).toEqual(Array.from(contentPrivateKey));
    });

    it('uses an authenticated v3 response when the QR includes pairing context', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        authCredentials = createDataKeyCredentials({ token: 'token-v3', machineKeyByte: 7 });
        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const pairingSecret = new Uint8Array(32).fill(11);

        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                pairingSecret,
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
            }));
        });

        const response = authApproveSpy.mock.calls[0]?.[3] as Uint8Array | undefined;
        expect(response).toBeDefined();
        expect(openTerminalProvisioningV3Payload({
            payload: response!,
            recipientSecretKeyOrSeed: terminalSecretKey,
            terminalEphemeralPublicKey: terminalPublicKey,
            pairingSecret,
            createdAtMs: 1_000,
            expiresAtMs: 61_000,
            nowMs: 2_000,
        })).toEqual(new Uint8Array(32).fill(7));
    });

    it('uses refreshed credentials after a server switch instead of the stale sync encryption key', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        activeServerUrl = 'https://api.happier.dev';

        const staleCredentials = createDataKeyCredentials({ token: 'token-old', machineKeyByte: 7 });
        const refreshedCredentials = createDataKeyCredentials({ token: 'token-new', machineKeyByte: 11 });
        authCredentials = staleCredentials;
        contentPrivateKey = new Uint8Array(32).fill(7);

        upsertActivateAndSwitchServerSpy.mockImplementationOnce(async () => {
            authCredentials = refreshedCredentials;
            return true;
        });

        const terminalSecretKey = new Uint8Array(32).fill(8);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(
                buildTerminalConnectUrl({ terminalPublicKey, serverUrl: 'https://stack.example.test' }),
            );
        });

        expect(result).toBe(true);
        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledTimes(1);
        const approveArgs = authApproveSpy.mock.calls[0] as unknown[] | undefined;
        const responseV2 = approveArgs?.[3] as Uint8Array | undefined;
        expect(responseV2).toBeDefined();
        const opened = openTerminalProvisioningV2Payload({ payload: responseV2!, recipientSecretKeyOrSeed: terminalSecretKey });
        expect(opened).not.toBeNull();
        expect(Array.from(opened!)).toEqual(Array.from(new Uint8Array(32).fill(11)));
    });

    it('keeps the current loopback server when approving terminal connect with active credentials', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();
        routerReplaceSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        activeServerUrl = 'http://127.0.0.1:33280';

        const currentCredentials = createDataKeyCredentials({ token: 'token-current-loopback', machineKeyByte: 13 });
        authCredentials = currentCredentials;

        const terminalSecretKey = new Uint8Array(32).fill(12);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ allowLoopbackServerOverride: true });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(
                buildTerminalConnectUrl({ terminalPublicKey, serverUrl: 'http://127.0.0.1:52753' }),
            );
        });

        expect(result).toBe(true);
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalledWith('/');
        const approveArgs = authApproveSpy.mock.calls[0] as unknown[] | undefined;
        expect(approveArgs?.[0]).toBe('token-current-loopback');
    });

    it('treats the active shareable relay URL as the current server when approving terminal connect', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();
        routerReplaceSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        activeServerUrl = 'http://127.0.0.1:24754';
        activeShareableServerUrl = 'http://127.0.0.1:52753';

        authCredentials = createDataKeyCredentials({ token: 'token-active-api', machineKeyByte: 15 });

        const terminalSecretKey = new Uint8Array(32).fill(14);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ allowLoopbackServerOverride: true });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(
                buildTerminalConnectUrl({ terminalPublicKey, serverUrl: 'http://127.0.0.1:52753' }),
            );
        });

        expect(result).toBe(true);
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        const approveArgs = authApproveSpy.mock.calls[0] as unknown[] | undefined;
        expect(approveArgs?.[0]).toBe('token-active-api');
    });

    it('uses the content private key in the v2 response bundle for legacy credentials by default', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();

        authCredentials = createLegacyCredentials({ token: 'token-legacy', secretByte: 6 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
        const terminalSecretKey = new Uint8Array(32).fill(6);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({ terminalPublicKey }));
        });

        expect(result).toBe(true);
        expect(authApproveSpy).toHaveBeenCalled();
        const approveArgs = authApproveSpy.mock.calls[0] as unknown[] | undefined;
        const responseV2 = approveArgs?.[3] as Uint8Array | undefined;
        expect(responseV2).toBeDefined();
        const opened = openTerminalProvisioningV2Payload({ payload: responseV2!, recipientSecretKeyOrSeed: terminalSecretKey });
        expect(opened).not.toBeNull();
        expect(Array.from(opened!)).toEqual(Array.from(deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(6))));
    });
});

describe('useConnectTerminal approval outcome messaging', () => {
    function createTerminalKeyPair(): { terminalSecretKey: Uint8Array; terminalPublicKey: Uint8Array } {
        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        return { terminalSecretKey, terminalPublicKey };
    }

    it("returns true and shows success modal when authApprove returns 'approved'", async () => {
        authApproveSpy.mockClear();
        modalAlertSpy.mockClear();

        authCredentials = createDataKeyCredentials({ token: 'token-approve', machineKeyByte: 7 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
        authApproveSpy.mockResolvedValue('approved');

        const onSuccessSpy = vi.fn();

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ onSuccess: onSuccessSpy });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const { terminalPublicKey } = createTerminalKeyPair();
        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({ terminalPublicKey }));
        });

        expect(result).toBe(true);
        expect(modalAlertSpy).toHaveBeenCalledWith('common.success', 'modals.terminalConnectedSuccessfully', [
            expect.objectContaining({ text: 'common.ok', onPress: expect.any(Function) }),
        ]);

        const buttons = (modalAlertSpy.mock.calls[0]?.[2] as Array<{ onPress?: () => void }> | undefined) ?? [];
        buttons[0]?.onPress?.();
        expect(onSuccessSpy).toHaveBeenCalledTimes(1);
    });

    it("returns false and shows 'already used' modal when authApprove returns 'already_authorized'", async () => {
        authApproveSpy.mockClear();
        modalAlertSpy.mockClear();

        authCredentials = createDataKeyCredentials({ token: 'token-already', machineKeyByte: 7 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
        authApproveSpy.mockResolvedValue('already_authorized');

        const onSuccessSpy = vi.fn();

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ onSuccess: onSuccessSpy });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const { terminalPublicKey } = createTerminalKeyPair();
        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({ terminalPublicKey }));
        });

        expect(result).toBe(false);
        expect(modalAlertSpy).toHaveBeenCalledWith('modals.terminalAlreadyConnected', 'modals.terminalConnectionAlreadyUsedDescription', [
            { text: 'common.ok' },
        ]);
        expect(onSuccessSpy).not.toHaveBeenCalled();
    });

    it("returns false and shows 'expired' modal when authApprove returns 'not_found'", async () => {
        authApproveSpy.mockClear();
        modalAlertSpy.mockClear();

        authCredentials = createDataKeyCredentials({ token: 'token-expired', machineKeyByte: 7 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
        authApproveSpy.mockResolvedValue('not_found');

        const onSuccessSpy = vi.fn();

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ onSuccess: onSuccessSpy });
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const { terminalPublicKey } = createTerminalKeyPair();
        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({ terminalPublicKey }));
        });

        expect(result).toBe(false);
        expect(modalAlertSpy).toHaveBeenCalledWith('modals.authRequestExpired', 'modals.authRequestExpiredDescription', [
            { text: 'common.ok' },
        ]);
        expect(onSuccessSpy).not.toHaveBeenCalled();
    });
});
