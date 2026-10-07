import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    encodeTerminalConnectLinkV4Payload,
    openTerminalProvisioningV3Response,
    openTerminalProvisioningV3Payload,
    type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';
import { buildTerminalConnectAuthRedirectHref } from '@/utils/path/terminalConnectUrl';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const routerPushSpy = vi.fn();
const setPendingTerminalConnectSpy = vi.fn((_pending: {
    publicKeyB64Url: string;
    serverUrl: string;
    serverIdentityId: string;
}) => {});
const clearPendingTerminalConnectSpy = vi.fn(() => {});
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
    async (): Promise<{ mode: 'plain' | 'e2ee'; updatedAt: number }> => ({ mode: 'e2ee', updatedAt: 0 }),
);
const isRuntimeFeatureEnabledSpy = vi.fn(async (_params: { featureId: string }) => true);
const promptLegacyPairingUpdateRequiredSpy = vi.fn(
    async (): Promise<'cancel' | 'scan_new_qr'> => 'cancel',
);

let authCredentials: any = null;
let storedCredentials: any = undefined;
let contentPrivateKey = new Uint8Array([7, 7, 7]);
let contentPublicKey = new Uint8Array([9, 9, 9]);
let activeServerUrl = 'https://api.happier.dev';
type TestServerProfile = {
    id: string;
    serverUrl: string;
    serverIdentityId?: string;
    canonicalServerUrl?: string;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
};

let serverProfiles: TestServerProfile[] = [{
    id: 'current-profile',
    serverUrl: 'https://api.happier.dev',
    serverIdentityId: 'srv_home_current',
}];
const getCredentialsForServerUrlSpy = vi.fn(async (url: string, options?: { serverId?: string }) => {
    const target = serverProfiles.find((profile) => (
        profile.serverUrl === url
        && profile.serverIdentityId === options?.serverId
    ));
    return target ? authCredentials : null;
});

afterEach(() => {
    authCredentials = null;
    storedCredentials = undefined;
    contentPrivateKey = new Uint8Array([7, 7, 7]);
    contentPublicKey = new Uint8Array([9, 9, 9]);
    activeServerUrl = 'https://api.happier.dev';
    serverProfiles = [{
        id: 'current-profile',
        serverUrl: 'https://api.happier.dev',
        serverIdentityId: 'srv_home_current',
    }];
    getCredentialsForServerUrlSpy.mockReset();
    getCredentialsForServerUrlSpy.mockImplementation(async (url: string, options?: { serverId?: string }) => {
        const target = serverProfiles.find((profile) => (
            profile.serverUrl === url
            && profile.serverIdentityId === options?.serverId
        ));
        return target ? authCredentials : null;
    });
    routerReplaceSpy.mockClear();
    routerPushSpy.mockClear();
    setPendingTerminalConnectSpy.mockClear();
    clearPendingTerminalConnectSpy.mockClear();
    modalAlertSpy.mockClear();
    modalAlertAsyncSpy.mockClear();
    modalConfirmSpy.mockClear();
    upsertActivateAndSwitchServerSpy.mockReset();
    authApproveSpy.mockReset();
    refreshFromActiveServerSpy.mockReset();
    fetchAccountEncryptionModeSpy.mockReset();
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
    isRuntimeFeatureEnabledSpy.mockReset();
    isRuntimeFeatureEnabledSpy.mockResolvedValue(true);
    promptLegacyPairingUpdateRequiredSpy.mockClear();
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
            router: { replace: routerReplaceSpy, push: routerPushSpy },
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
        // Reached lazily: `@/dev/testkit` now imports this module during the test file's own
        // import phase, before the top-level spy bindings initialize.
        getCredentialsForServerUrl: (url: string, options?: { serverId?: string }) =>
            getCredentialsForServerUrlSpy(url, options),
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
        listServerProfiles: () => serverProfiles,
        // Mirrors the canonical persisted-profile identity resolution over this fixture's
        // profile set, so the hook consumes the same owner production uses.
        resolveServerProfileForPortableIdentity: (idRaw: string | null | undefined) => {
            const serverIdentityId = String(idRaw ?? '').trim();
            if (!serverIdentityId) return { kind: 'missing', serverIdentityId: '' };
            const profiles = serverProfiles.filter((profile) => profile.serverIdentityId === serverIdentityId);
            if (profiles.length === 1) return { kind: 'resolved', serverIdentityId, profile: profiles[0] };
            if (profiles.length > 1) return { kind: 'ambiguous', serverIdentityId, profiles };
            return { kind: 'missing', serverIdentityId };
        },
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
    clearPendingTerminalConnect: clearPendingTerminalConnectSpy,
}));

vi.mock('@/auth/pairing/legacyPairingUpdateRequired', () => ({
    promptLegacyPairingUpdateRequired: promptLegacyPairingUpdateRequiredSpy,
}));

// `authApproveSpy` records calls to the resolved Home-transport v3 approval owner.
vi.mock('@/auth/flows/approve', () => ({
    authApproveWithTransport: authApproveSpy,
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
    encodeBase64: vi.fn((value: Uint8Array) => Buffer.from(value).toString('base64')),
}));

vi.mock('@/sync/sync', () => ({
    sync: { encryption: { contentDataKey: contentPublicKey, getContentPrivateKey: () => contentPrivateKey } },
}));

function buildTerminalConnectUrl(params: Readonly<{
    terminalPublicKey: Uint8Array;
    serverUrl?: string;
    pairing?: Readonly<{
        secret: Uint8Array;
        createdAtMs: number;
        expiresAtMs: number;
    }>;
    supportsTokenOnly?: boolean;
    serverIdentityId?: string;
}>): string {
    const publicKeyB64Url = Buffer.from(params.terminalPublicKey).toString('base64url');
    const serverUrl = params.serverUrl ?? 'https://api.happier.dev';
    if (!params.pairing) {
        return `happier://terminal?key=${publicKeyB64Url}&server=${encodeURIComponent(serverUrl)}`;
    }
    const homeServerIdentityId = params.serverIdentityId ?? 'srv_home_current';
    const descriptor: HomeConnectionDescriptorV1 = {
        v: 1,
        homeServerIdentityId,
        canonicalServerUrl: serverUrl,
        revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }],
    };
    const payload = encodeTerminalConnectLinkV4Payload({
        v: 4,
        publicKeyB64Url,
        pairing: {
            v: 3,
            secretB64Url: Buffer.from(params.pairing.secret).toString('base64url'),
            createdAtMs: params.pairing.createdAtMs,
            expiresAtMs: params.pairing.expiresAtMs,
            homeServerIdentityId,
            supportsTokenOnly: params.supportsTokenOnly === true,
        },
        homeConnectionDescriptor: descriptor,
    });
    return `happier://terminal?v4=${payload}`;
}

function buildIdentityBearingV3TerminalConnectUrl(params: Readonly<{
    terminalPublicKey: Uint8Array;
    serverUrl: string;
    serverIdentityId: string;
    pairing: Readonly<{
        secret: Uint8Array;
        createdAtMs: number;
        expiresAtMs: number;
    }>;
    supportsTokenOnly?: boolean;
}>): string {
    return `happier://terminal?key=${Buffer.from(params.terminalPublicKey).toString('base64url')}`
        + `&server=${encodeURIComponent(params.serverUrl)}`
        + `&serverIdentityId=${encodeURIComponent(params.serverIdentityId)}`
        + `&pairingSecret=${Buffer.from(params.pairing.secret).toString('base64url')}`
        + `&createdAt=${params.pairing.createdAtMs}`
        + `&expiresAt=${params.pairing.expiresAtMs}`
        + (params.supportsTokenOnly ? '&supportsTokenOnly=1' : '');
}

function createDataKeyCredentials(params: Readonly<{ token: string; machineKeyByte: number; publicKeyByte?: number }>) {
    const machineKey = new Uint8Array(32).fill(params.machineKeyByte);
    // The canonical provisioning resolver rejects mismatched key material, so the fixture
    // derives the public key from its machine scalar exactly as production credentials do.
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    return {
        token: params.token,
        encryption: {
            publicKey: Buffer.from(publicKey).toString('base64'),
            machineKey: Buffer.from(machineKey).toString('base64'),
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
    it.each([
        ['https', '&server=https%3A%2F%2Fhome.example.test'],
        ['http', '&server=http%3A%2F%2Flan.example.test'],
        ['no-server', ''],
    ])('returns typed update-required refusal for immutable preview.2 %s pairing without authority mutation', async (_case, server) => {
        const tuple = 'key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
            + `${server}`
            + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1000&expiresAt=61000';
        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(`happier://terminal?${tuple}`);
        });

        expect(result).toBe(false);
        expect(promptLegacyPairingUpdateRequiredSpy).toHaveBeenCalledOnce();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(setPendingTerminalConnectSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(authApproveSpy).not.toHaveBeenCalled();
        expect(getCredentialsForServerUrlSpy).not.toHaveBeenCalled();
        expect(activeServerUrl).toBe('https://api.happier.dev');
    });

    it('honors the canonical legacy-pairing scan-new-QR reentry action', async () => {
        promptLegacyPairingUpdateRequiredSpy.mockResolvedValueOnce('scan_new_qr');
        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await hookApi!.processAuthUrl(
                'happier://terminal?key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
                + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
                + '&createdAt=1000&expiresAt=61000',
            );
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
    });

    it('preserves the strict V4 descriptor while redirecting to sign-in', async () => {
        storedCredentials = null;
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_current',
            canonicalServerUrl: 'https://api.happier.dev',
            revision: 1,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
        };
        const payload = encodeTerminalConnectLinkV4Payload({
            v: 4,
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            pairing: {
                v: 3,
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                supportsTokenOnly: true,
            },
            homeConnectionDescriptor: descriptor,
        });

        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await hookApi!.processAuthUrl(`happier://terminal?v4=${payload}`);
        });

        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverIdentityId: descriptor.homeServerIdentityId,
            homeConnectionDescriptor: descriptor,
        }));
    });

    it('keeps a declined strict V4 target bound without redirecting auth through the active Home', async () => {
        storedCredentials = null;
        activeServerUrl = 'https://lan.example.test:53288';
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_loopback_target',
            canonicalServerUrl: 'http://127.0.0.1:3005',
            revision: 1,
            endpoints: [{ kind: 'iroh' as const, endpointId: 'b'.repeat(64) }],
        };
        const payload = encodeTerminalConnectLinkV4Payload({
            v: 4,
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            pairing: {
                v: 3,
                secretB64Url: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
                createdAtMs: 1_900_000_000_000,
                expiresAtMs: 1_900_000_060_000,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                supportsTokenOnly: false,
            },
            homeConnectionDescriptor: descriptor,
        });
        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ allowLoopbackServerOverride: true });
            return null;
        }
        await renderScreen(React.createElement(Probe));

        await act(async () => {
            await hookApi!.processAuthUrl(`happier://terminal?v4=${payload}`);
        });

        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: descriptor.canonicalServerUrl,
            homeConnectionDescriptor: descriptor,
        }));
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'welcome.serverUnavailableTitle',
            'welcome.serverUnavailableBody',
            expect.any(Array),
        );
    });

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
            serverIdentityId: '',
        });
        expect(modalAlertSpy).toHaveBeenCalledWith('terminal.connectTerminal', 'modals.pleaseSignInFirst', [
            { text: 'common.continue' },
        ]);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Fapi.happier.dev');
    });

    it('preserves focus while redirecting an unauthenticated explicit target', async () => {
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
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Fstack.example.test');
    });

    it('does not refresh or reuse focused auth for an unknown explicit target', async () => {
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
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(refreshFromActiveServerSpy).not.toHaveBeenCalled();
        expect(authApproveSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Fstack.example.test');
    });

    it('does not switch servers when the link server URL is loopback-equivalent to the active server URL', async () => {
        upsertActivateAndSwitchServerSpy.mockClear();
        authApproveSpy.mockClear();
        modalAlertSpy.mockClear();

        activeServerUrl = 'https://happier-stack.localhost:3121';
        serverProfiles = [{
            id: 'current-profile',
            serverUrl: 'https://localhost:3121',
            serverIdentityId: 'srv_home_current',
        }];
        authCredentials = createDataKeyCredentials({ token: 'token-1', machineKeyByte: 7 });
        authApproveSpy.mockResolvedValue('approved');

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

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'https://localhost:3121',
                pairing: { secret: pairingSecret, createdAtMs: 1_800_000_000_000, expiresAtMs: 1_800_060_000_000 },
                supportsTokenOnly: true,
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
            serverIdentityId: '',
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
            serverIdentityId: '',
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/?server=https%3A%2F%2Flan.example.test%3A53288');
    });

    it('seals a pairing-bound v3 dataKey response and posts it to the explicit target with its response kind', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();

        authCredentials = createDataKeyCredentials({ token: 'token-1', machineKeyByte: 7 });
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
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
        expect(authApproveSpy).toHaveBeenCalledTimes(1);
        expect(authApproveSpy).toHaveBeenCalledWith(expect.objectContaining({
            transport: expect.objectContaining({
                canonicalServerUrl: 'https://api.happier.dev',
            }),
            token: 'token-1',
            publicKeyBase64: Buffer.from(terminalPublicKey).toString('base64'),
            responseKind: 'dataKey',
        }));
        const approveParams = authApproveSpy.mock.calls[0]?.[0] as { responseBase64: string } | undefined;
        expect(approveParams?.responseBase64).toBeDefined();
        const opened = openTerminalProvisioningV3Payload({
            payload: new Uint8Array(Buffer.from(approveParams!.responseBase64, 'base64')),
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        });
        expect(opened).toEqual(contentPrivateKey);
    });

    it('fails closed without posting when a dataKey link has no authenticated pairing context', async () => {
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

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({ terminalPublicKey }));
        });

        expect(result).toBe(false);
        expect(authApproveSpy).not.toHaveBeenCalled();
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

        const approveParams = authApproveSpy.mock.calls[0]?.[0] as { responseBase64: string } | undefined;
        expect(approveParams?.responseBase64).toBeDefined();
        expect(openTerminalProvisioningV3Payload({
            payload: new Uint8Array(Buffer.from(approveParams!.responseBase64, 'base64')),
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        })).toEqual(contentPrivateKey);
    });

    it('provisions token-only credentials only as authenticated v3 after plain policy is proven', async () => {
        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
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
            expect.objectContaining({ retry: 'none' }),
        );
        expect(isRuntimeFeatureEnabledSpy.mock.calls.map(([params]) => params.featureId)).toEqual([
            'encryption.plaintextStorage',
            'e2ee.keylessAccounts',
        ]);
        expect(authApproveSpy).toHaveBeenCalledWith(expect.objectContaining({
            transport: expect.objectContaining({
                canonicalServerUrl: 'https://api.happier.dev',
            }),
            token: 'plain-token',
            responseKind: 'tokenOnly',
        }));
        const approveParams = authApproveSpy.mock.calls[0]?.[0] as { responseBase64: string } | undefined;
        expect(approveParams?.responseBase64).toBeDefined();
        expect(openTerminalProvisioningV3Response({
            payload: new Uint8Array(Buffer.from(approveParams!.responseBase64, 'base64')),
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        })).toEqual({ type: 'tokenOnly' });
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
        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
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

    it('uses the parsed Home credentials without changing the focused Home', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();
        activeServerUrl = 'https://api.happier.dev';

        const focusedCredentials = createDataKeyCredentials({ token: 'token-old', machineKeyByte: 7 });
        const targetCredentials = createDataKeyCredentials({ token: 'token-new', machineKeyByte: 11 });
        authCredentials = focusedCredentials;
        contentPrivateKey = new Uint8Array(32).fill(7);
        const verifiedDescriptor: HomeConnectionDescriptorV1 = {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://stack.example.test',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://stack.example.test' }],
        };
        serverProfiles = [{
            id: 'home-b-profile',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_home_b',
            canonicalServerUrl: verifiedDescriptor.canonicalServerUrl,
            homeConnectionDescriptor: verifiedDescriptor,
        }];
        getCredentialsForServerUrlSpy.mockResolvedValue(targetCredentials);

        const terminalSecretKey = new Uint8Array(32).fill(8);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');

        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const pairingSecret = new Uint8Array(32).fill(12);
        const createdAtMs = 1_800_000_000_000;
        const expiresAtMs = createdAtMs + 60_000;

        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildIdentityBearingV3TerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'https://stack.example.test',
                serverIdentityId: 'srv_home_b',
                pairing: { secret: pairingSecret, createdAtMs, expiresAtMs },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(true);
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(activeServerUrl).toBe('https://api.happier.dev');
        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith(
            'https://stack.example.test',
            { serverId: 'srv_home_b' },
        );
        expect(authApproveSpy).toHaveBeenCalledWith(expect.objectContaining({
            transport: expect.objectContaining({
                canonicalServerUrl: 'https://stack.example.test',
                homeServerIdentityId: 'srv_home_b',
            }),
            token: 'token-new',
            responseKind: 'dataKey',
        }));
        const approveParams = authApproveSpy.mock.calls[0]?.[0] as { responseBase64: string } | undefined;
        const opened = openTerminalProvisioningV3Payload({
            payload: new Uint8Array(Buffer.from(approveParams!.responseBase64, 'base64')),
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        });
        expect(opened).toEqual(new Uint8Array(32).fill(11));
    });

    it('does not disclose focused credentials when the same URL is bound to another Home identity', async () => {
        authApproveSpy.mockClear();
        authCredentials = createDataKeyCredentials({ token: 'focused-token', machineKeyByte: 7 });
        activeServerUrl = 'https://shared.example.test';
        serverProfiles = [{
            id: 'focused-profile',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_focused',
            canonicalServerUrl: 'https://shared.example.test',
            homeConnectionDescriptor: {
                v: 1,
                homeServerIdentityId: 'srv_focused',
                canonicalServerUrl: 'https://shared.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://shared.example.test' }],
            },
        }];

        const terminalSecretKey = new Uint8Array(32).fill(8);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildIdentityBearingV3TerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'https://shared.example.test',
                serverIdentityId: 'srv_expected_other',
                pairing: {
                    secret: new Uint8Array(32).fill(12),
                    createdAtMs: 1_800_000_000_000,
                    expiresAtMs: 1_800_060_000_000,
                },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(false);
        expect(authApproveSpy).not.toHaveBeenCalled();
        expect(getCredentialsForServerUrlSpy).not.toHaveBeenCalled();
    });

    // Credential shape is the material authority, and the CLI owns that policy for every
    // authenticated approver: `apps/cli/src/auth/terminalProvisioningMaterial.ts`
    // resolves keyed credentials — data-key or legacy recovery-secret — to the same Account
    // content private key, deriving the legacy one through the protocol derivation owner
    // (`deriveAccountMachineKeyFromRecoverySecret`) instead of a second formula. The UI
    // resolver (`auth/terminal/resolveProvisioningMaterial.ts`) follows that one policy, so a
    // legacy-credential approval provisions a dataKey response. What must never happen is the
    // raw recovery secret itself reaching the terminal, which is what this test pins.
    it('provisions the derived Account content key for legacy credentials and never posts the recovery secret', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();

        const recoverySecret = new Uint8Array(32).fill(6);
        authCredentials = createLegacyCredentials({ token: 'token-legacy', secretByte: 6 });
        // Deliberately distinct from the derived key: the ambient sync encryption must not be
        // the material source for a credential-scoped approval.
        contentPrivateKey = new Uint8Array(32).fill(7);
        contentPublicKey = new Uint8Array([9, 9, 9]);
        const terminalSecretKey = new Uint8Array(32).fill(6);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const pairingSecret = new Uint8Array(32).fill(12);
        const createdAtMs = 1_800_000_000_000;
        const expiresAtMs = 1_800_060_000_000;

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
        expect(authApproveSpy).toHaveBeenCalledTimes(1);
        expect(authApproveSpy).toHaveBeenCalledWith(expect.objectContaining({
            token: 'token-legacy',
            responseKind: 'dataKey',
        }));
        const approveParams = authApproveSpy.mock.calls[0]?.[0] as { responseBase64: string } | undefined;
        const opened = openTerminalProvisioningV3Payload({
            payload: new Uint8Array(Buffer.from(approveParams!.responseBase64, 'base64')),
            recipientSecretKeyOrSeed: terminalSecretKey,
            pairingSecret,
            terminalEphemeralPublicKey: terminalPublicKey,
            createdAtMs,
            expiresAtMs,
            nowMs: createdAtMs + 1,
        });
        expect(opened).toEqual(deriveAccountMachineKeyFromRecoverySecret(recoverySecret));
        expect(opened).not.toEqual(recoverySecret);
        expect(opened).not.toEqual(contentPrivateKey);
    });

    it('keeps an unverified explicit loopback target pending without approving the saved Home at another host', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        upsertActivateAndSwitchServerSpy.mockClear();

        // Matching Home identity selects the saved profile, but does not prove that this
        // explicit alternate origin is its authenticated transport.
        activeServerUrl = 'https://stack-host.example.test:53288';
        const descriptor: HomeConnectionDescriptorV1 = {
            v: 1,
            homeServerIdentityId: 'srv_stack_home',
            canonicalServerUrl: 'https://stack-host.example.test:53288',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://stack-host.example.test:53288' }],
        };
        serverProfiles = [{
            id: 'stack-profile',
            serverUrl: 'https://stack-host.example.test:53288',
            serverIdentityId: 'srv_stack_home',
            canonicalServerUrl: descriptor.canonicalServerUrl,
            homeConnectionDescriptor: descriptor,
        }];
        authCredentials = createDataKeyCredentials({ token: 'stack-token', machineKeyByte: 11 });
        contentPrivateKey = new Uint8Array(32).fill(7);

        const terminalSecretKey = new Uint8Array(32).fill(4);
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
            result = await hookApi!.processAuthUrl(buildIdentityBearingV3TerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'http://localhost:53288',
                serverIdentityId: 'srv_stack_home',
                pairing: {
                    secret: new Uint8Array(32).fill(12),
                    createdAtMs: 1_800_000_000_000,
                    expiresAtMs: 1_800_060_000_000,
                },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(false);
        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith(
            'https://stack-host.example.test:53288',
            { serverId: 'srv_stack_home' },
        );
        expect(authApproveSpy).not.toHaveBeenCalled();
        expect(setPendingTerminalConnectSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'http://localhost:53288',
            serverIdentityId: 'srv_stack_home',
        }));
        expect(routerReplaceSpy).toHaveBeenCalledWith(
            buildTerminalConnectAuthRedirectHref({ serverUrl: 'http://localhost:53288' }),
        );
        expect(activeServerUrl).toBe('https://stack-host.example.test:53288');
    });

    it('approves an identity-bearing URL-only link for a Home that publishes no connection descriptor', async () => {
        authApproveSpy.mockClear();
        authApproveSpy.mockResolvedValue('approved');
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        // Exact live state of the reproduced defect: a loopback-HTTP Home publishes no
        // `homeConnectionDescriptor` at all (`/v1/features` carries only `serverIdentity`), its
        // profile id was derived from a different address than its serverUrl, and the CLI still
        // issues an identity-bearing URL-only pairing link naming `127.0.0.1`.
        activeServerUrl = 'http://happier-repo-dev-a1cc5e0671.localhost:53288';
        serverProfiles = [{
            id: '192.168.5.15-53288',
            serverUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
            serverIdentityId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
        }];
        authCredentials = createDataKeyCredentials({ token: 'home-token', machineKeyByte: 13 });
        contentPrivateKey = new Uint8Array(32).fill(7);

        const terminalSecretKey = new Uint8Array(32).fill(2);
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
            result = await hookApi!.processAuthUrl(buildIdentityBearingV3TerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'http://127.0.0.1:53288',
                serverIdentityId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
                pairing: {
                    secret: new Uint8Array(32).fill(12),
                    createdAtMs: 1_800_000_000_000,
                    expiresAtMs: 1_800_060_000_000,
                },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(true);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith(
            'http://happier-repo-dev-a1cc5e0671.localhost:53288',
            { serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN' },
        );
        // The approval is posted to this device's established Home address, bound to its identity.
        expect(authApproveSpy).toHaveBeenCalledWith(expect.objectContaining({
            transport: expect.objectContaining({
                canonicalServerUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
                homeServerIdentityId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
            }),
            token: 'home-token',
        }));
    });

    it('names both Homes and leaves nothing pending when an authenticated user declines the Home switch', async () => {
        authApproveSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        routerReplaceSpy.mockClear();
        setPendingTerminalConnectSpy.mockClear();
        clearPendingTerminalConnectSpy.mockClear();

        activeServerUrl = 'https://api.happier.dev';
        authCredentials = createDataKeyCredentials({ token: 'focused-token', machineKeyByte: 7 });
        modalConfirmSpy.mockResolvedValueOnce(false);

        const terminalSecretKey = new Uint8Array(32).fill(3);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

        const { useConnectTerminal } = await import('./useConnectTerminal');
        let hookApi: ReturnType<typeof useConnectTerminal> | null = null;
        function Probe() {
            hookApi = useConnectTerminal({ allowLoopbackServerOverride: true });
            return null;
        }
        await renderScreen(React.createElement(Probe));

        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildIdentityBearingV3TerminalConnectUrl({
                terminalPublicKey,
                serverUrl: 'https://other-home.example.test',
                serverIdentityId: 'srv_other_home',
                pairing: {
                    secret: new Uint8Array(32).fill(12),
                    createdAtMs: 1_800_000_000_000,
                    expiresAtMs: 1_800_060_000_000,
                },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(false);
        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'terminal.connectTerminal',
            'terminal.switchServerToConnectTerminal',
            expect.objectContaining({ confirmText: 'server.switchToServer' }),
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(setPendingTerminalConnectSpy).not.toHaveBeenCalled();
        expect(clearPendingTerminalConnectSpy).toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(authApproveSpy).not.toHaveBeenCalled();
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
        const pairingSecret = new Uint8Array(32).fill(12);
        let result = false;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                pairing: { secret: pairingSecret, createdAtMs: 1_800_000_000_000, expiresAtMs: 1_800_060_000_000 },
                supportsTokenOnly: true,
            }));
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
        const pairingSecret = new Uint8Array(32).fill(12);
        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                pairing: { secret: pairingSecret, createdAtMs: 1_800_000_000_000, expiresAtMs: 1_800_060_000_000 },
                supportsTokenOnly: true,
            }));
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
        const pairingSecret = new Uint8Array(32).fill(12);
        let result = true;
        await act(async () => {
            result = await hookApi!.processAuthUrl(buildTerminalConnectUrl({
                terminalPublicKey,
                pairing: { secret: pairingSecret, createdAtMs: 1_800_000_000_000, expiresAtMs: 1_800_060_000_000 },
                supportsTokenOnly: true,
            }));
        });

        expect(result).toBe(false);
        expect(modalAlertSpy).toHaveBeenCalledWith('modals.authRequestExpired', 'modals.authRequestExpiredDescription', [
            { text: 'common.ok' },
        ]);
        expect(onSuccessSpy).not.toHaveBeenCalled();
    });
});
