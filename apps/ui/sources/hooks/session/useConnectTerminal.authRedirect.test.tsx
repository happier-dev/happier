import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    openTerminalProvisioningV3Response,
    openTerminalProvisioningV2Payload,
    openTerminalProvisioningV3Payload,
} from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const setPendingTerminalConnectSpy = vi.fn((_pending: { publicKeyB64Url: string; serverUrl: string }) => {});
const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
const modalAlertAsyncSpy = vi.fn(async (...args: unknown[]) => {
    modalAlertSpy(...args);
});
const modalConfirmSpy = vi.fn(async () => true);
const upsertActivateAndSwitchServerSpy = vi.fn(async (_params: {
    serverUrl: string;
    source: string;
    scope: string;
    refreshAuth?: (() => Promise<void>) | null;
}) => true);
const authApproveSpy = vi.fn();
const refreshFromActiveServerSpy = vi.fn(async () => {});
const fetchAccountEncryptionModeSpy = vi.fn(
    async (): Promise<{ mode: 'plain' | 'e2ee'; updatedAt: number }> => ({ mode: 'plain', updatedAt: 0 }),
);
const isRuntimeFeatureEnabledSpy = vi.fn(async (_params: { featureId: string }) => true);

let authCredentials: any = null;
let storedCredentials: any = undefined;
let contentPrivateKey = new Uint8Array([7, 7, 7]);
let contentPublicKey = new Uint8Array([9, 9, 9]);
let activeServerUrl = 'https://api.happier.dev';

afterEach(() => {
    authCredentials = null;
    storedCredentials = undefined;
    contentPrivateKey = new Uint8Array([7, 7, 7]);
    contentPublicKey = new Uint8Array([9, 9, 9]);
    activeServerUrl = 'https://api.happier.dev';
    routerReplaceSpy.mockClear();
    setPendingTerminalConnectSpy.mockClear();
    modalAlertSpy.mockClear();
    modalAlertAsyncSpy.mockClear();
    modalConfirmSpy.mockClear();
    upsertActivateAndSwitchServerSpy.mockReset();
    authApproveSpy.mockReset();
    refreshFromActiveServerSpy.mockReset();
    fetchAccountEncryptionModeSpy.mockReset();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    isRuntimeFeatureEnabledSpy.mockReset();
    isRuntimeFeatureEnabledSpy.mockResolvedValue(true);
});

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
    useAuth: () => ({ credentials: authCredentials, refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => (storedCredentials === undefined ? authCredentials : storedCredentials)),
    },
    isDataKeyAuthCredentials: (creds: { encryption?: { machineKey?: string } } | null) =>
        typeof creds?.encryption?.machineKey === 'string',
    isLegacyAuthCredentials: (creds: { secret?: string } | null) => typeof creds?.secret === 'string' && creds.secret.length > 0,
    isTokenOnlyAuthCredentials: (creds: { secret?: string; encryption?: unknown } | null) =>
        Boolean(creds) && typeof creds?.secret !== 'string' && !creds?.encryption,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        getActiveServerUrl: () => activeServerUrl,
    };
});

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    isSameServerUrl: (left: string, right: string) => {
        const normalizeLoopback = (raw: string) => {
            const value = String(raw ?? '').trim().replace(/\/+$/, '');
            try {
                const parsed = new URL(value);
                const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
                const loopback =
                    host === 'localhost'
                    || host === '127.0.0.1'
                    || host === '::1'
                    || host === '[::1]'
                    || host.endsWith('.localhost');
                parsed.hostname = loopback ? 'localhost' : host;
                return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`.replace(/\/+$/, '');
            } catch {
                return value;
            }
        };
        return normalizeLoopback(left) === normalizeLoopback(right);
    },
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

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: isRuntimeFeatureEnabledSpy,
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
    pairing?: Readonly<{
        secret: Uint8Array;
        createdAtMs: number;
        expiresAtMs: number;
    }>;
    supportsTokenOnly?: boolean;
}>): string {
    const publicKeyB64Url = Buffer.from(params.terminalPublicKey).toString('base64url');
    const server = encodeURIComponent(params.serverUrl ?? 'https://api.happier.dev');
    const pairing = params.pairing
        ? `&pairingSecret=${Buffer.from(params.pairing.secret).toString('base64url')}`
            + `&createdAt=${params.pairing.createdAtMs}`
            + `&expiresAt=${params.pairing.expiresAtMs}`
            + (params.supportsTokenOnly ? '&supportsTokenOnly=1' : '')
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

function createTokenOnlyCredentials(params: Readonly<{ token: string }>) {
    return { token: params.token } as const;
}

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
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Fapi.happier.dev');
    });

    it('auto-switches server without confirmation prompt before redirecting unauthenticated users', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();
        activeServerUrl = 'http://127.0.0.1:52753';
        storedCredentials = null;

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
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Fstack.example.test');
    });

    it('refreshes auth state when switching to another server before redirecting terminal connect to sign-in', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        refreshFromActiveServerSpy.mockClear();
        authApproveSpy.mockClear();

        activeServerUrl = 'https://api.happier.dev';
        authCredentials = createDataKeyCredentials({ token: 'relay-token', machineKeyByte: 7 });
        storedCredentials = null;
        upsertActivateAndSwitchServerSpy.mockImplementationOnce(async (params) => {
            await params.refreshAuth?.();
            return true;
        });

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(
                buildTerminalConnectUrl({ terminalPublicKey, serverUrl: 'https://stack.example.test' }),
            );
        });

        expect(result).toBe(false);
        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                serverUrl: 'https://stack.example.test',
                source: 'url',
                scope: 'device',
                refreshAuth: refreshFromActiveServerSpy,
            }),
        );
        expect(refreshFromActiveServerSpy).toHaveBeenCalledTimes(1);
        expect(authApproveSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Fstack.example.test');
    });

    it('does not switch servers when the link server URL is loopback-equivalent to the active server URL', async () => {
        upsertActivateAndSwitchServerSpy.mockClear();
        authApproveSpy.mockClear();
        modalAlertSpy.mockClear();

        activeServerUrl = 'http://happier-stack.localhost:3121';
        authCredentials = createDataKeyCredentials({ token: 'token-1', machineKeyByte: 7 });
        authApproveSpy.mockResolvedValue('approved');

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
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'http://localhost:3121',
            }));
        });

        expect(result).toBe(true);
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(authApproveSpy).toHaveBeenCalledTimes(1);
    });

    it('does not switch to a different loopback server URL when the active server is already loopback', async () => {
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();

        activeServerUrl = 'http://127.0.0.1:43005';
        authCredentials = null;
        storedCredentials = null;

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
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=http%3A%2F%2F127.0.0.1%3A43005');
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
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Flan.example.test%3A53288');
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

    it('authenticates a v3 response with the QR-only pairing secret when the link provides one', async () => {
        authApproveSpy.mockResolvedValue('approved');
        authCredentials = createDataKeyCredentials({ token: 'token-1', machineKeyByte: 7 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const pairingSecret = new Uint8Array(32).fill(12);
        const createdAtMs = 1_800_000_000_000;
        const expiresAtMs = createdAtMs + 60_000;

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
                pairing: { secret: pairingSecret, createdAtMs, expiresAtMs },
                supportsTokenOnly: true,
            }));
        });

        const responseV3 = authApproveSpy.mock.calls[0]?.[3] as Uint8Array | undefined;
        expect(responseV3).toBeDefined();
        expect(openTerminalProvisioningV3Payload({
            payload: responseV3!,
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        })).toEqual(contentPrivateKey);
    });

    it('provisions token-only credentials only as authenticated v3 after plain policy is proven', async () => {
        authApproveSpy.mockResolvedValue('approved');
        authCredentials = createTokenOnlyCredentials({ token: 'plain-token' });
        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const pairingSecret = new Uint8Array(32).fill(12);
        const createdAtMs = 1_800_000_000_000;
        const expiresAtMs = createdAtMs + 60_000;

        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                pairing: { secret: pairingSecret, createdAtMs, expiresAtMs },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(true);
        expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledWith(
            authCredentials,
            { retry: 'none' },
        );
        expect(isRuntimeFeatureEnabledSpy.mock.calls.map(([params]) => params.featureId)).toEqual([
            'encryption.plaintextStorage',
            'e2ee.keylessAccounts',
        ]);
        const responseV3 = authApproveSpy.mock.calls[0]?.[3] as Uint8Array | undefined;
        expect(responseV3).toBeDefined();
        expect(openTerminalProvisioningV3Response({
            payload: responseV3!,
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        })).toEqual({ type: 'tokenOnly' });
        expect(authApproveSpy.mock.calls[0]?.[2]).toEqual(new Uint8Array());
    });

    it.each([
        {
            name: 'the QR has no authenticated pairing context',
            configure: () => {},
            withPairing: false,
            supportsTokenOnly: true,
        },
        {
            name: 'the authenticated reader did not advertise token-only support',
            configure: () => {},
            withPairing: true,
            supportsTokenOnly: false,
        },
        {
            name: 'the authenticated account mode is E2EE',
            configure: () => fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 }),
            withPairing: true,
            supportsTokenOnly: true,
        },
        {
            name: 'a required server feature decision is unavailable',
            configure: () => isRuntimeFeatureEnabledSpy.mockResolvedValueOnce(false),
            withPairing: true,
            supportsTokenOnly: true,
        },
    ])('fails closed for token-only pairing when $name', async ({ configure, withPairing, supportsTokenOnly }) => {
        configure();
        authCredentials = createTokenOnlyCredentials({ token: 'plain-token' });
        const terminalSecretKey = new Uint8Array(32).fill(5);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const pairingSecret = new Uint8Array(32).fill(12);

        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                ...(withPairing
                    ? { pairing: { secret: pairingSecret, createdAtMs: 1_000, expiresAtMs: 61_000 } }
                    : {}),
                supportsTokenOnly,
            }));
        });

        expect(result).toBe(false);
        expect(authApproveSpy).not.toHaveBeenCalled();
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
            expect.objectContaining({ text: 'common.ok' }),
        ]);
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
