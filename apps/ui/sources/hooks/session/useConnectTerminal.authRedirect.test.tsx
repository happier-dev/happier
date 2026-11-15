import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    deriveAccountMachineKeyFromRecoverySecret} from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    encodeTerminalConnectLinkV4Payload} from '@happier-dev/protocol/auth/terminalConnectLinkV4';
import {
    openTerminalProvisioningV3Payload,
    openTerminalProvisioningV3Response} from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import {
    type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol/auth/accountDirectory';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { IModal } from '@/modal';
import type { NativeIrohModule } from '@happier-dev/iroh-native';
import { buildTerminalConnectLinks } from '@happier-dev/cli-common/links';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionHooksCommonModuleMocks } from './sessionHooksTestHelpers';
import { buildTerminalConnectAuthRedirectHref } from '@/utils/path/terminalConnectUrl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
const routerPushSpy = vi.fn();
const modalAlertSpy = vi.fn<IModal['alert']>();
const modalAlertAsyncSpy = vi.fn<IModal['alertAsync']>(async (...args) => { modalAlertSpy(...args); });
const modalConfirmSpy = vi.fn<IModal['confirm']>(async () => true);
const secureStore = vi.hoisted(() => new Map<string, string>());
const nativeIroh = vi.hoisted(() => ({ enabled: false }));

// The optional Expo SDK lookup is the genuine native boundary. Its adapters,
// lease supervisor, readiness/identity probes and enrollment selection stay real.
vi.mock('../../../../../packages/iroh-native/src/HappierIrohNative', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../packages/iroh-native/src/HappierIrohNative')>();
    const native = {
        getAvailability: () => ({ available: true }),
        createEndpoint: async () => ({ endpointHandle: 'auth-redirect-client', endpointId: 'c'.repeat(64),
            relayPolicy: 'automatic', relayMode: 'disabled', capProfile: 'homeInteractive', relayUrls: [] }),
        ensureHomeTunnel: async (input) => ({ tunnelId: 'auth-redirect-tunnel', endpointHandle: input.endpointHandle,
            homeServerIdentityId: input.homeServerIdentityId, homeEndpointId: input.endpointId,
            runtimeOrigin: 'http://127.0.0.1:48124', carrier: 'iroh', observedPath: 'direct', startedAtMs: Date.now() }),
        releaseHomeTunnel: async () => {},
        shutdownEndpoint: async () => {},
        getTunnelStatus: async () => ({ connectionActive: true, observedPath: 'direct' }),
    } satisfies NativeIrohModule;
    return { ...actual, getOptionalHappierIrohNativeModule: () => nativeIroh.enabled ? native : null };
});

// Only presentation, navigation, device storage and native SDK ports are replaced.
// Credential qualification, Home selection, Account currentness and sealing stay real.
installSessionHooksCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Dimensions: { get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }) },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { replace: routerReplaceSpy, push: routerPushSpy } }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: {
            alert: (...args) => modalAlertSpy(...args),
            alertAsync: (...args) => modalAlertAsyncSpy(...args),
            confirm: (...args) => modalConfirmSpy(...args),
        } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: key => key });
    },
});
vi.mock('expo-camera', () => ({ CameraView: {
    isModernBarcodeScannerAvailable: false,
    onModernBarcodeScanned: vi.fn(), launchScanner: vi.fn(), dismissScanner: vi.fn(),
} }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
    deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));
vi.mock('@tauri-apps/api/core', async () => {
    const { createDesktopSecureStorageBoundary } = await import('@/dev/testkit/mocks/desktopSecureStorage');
    return { invoke: createDesktopSecureStorageBoundary().invoke };
});

const { renderScreen, standardCleanup } = await import('@/dev/testkit');
await initializeRealAppRuntimeForTests();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { useConnectTerminal } = await import('./useConnectTerminal');
const profiles = await import('@/sync/domains/server/serverProfiles');
const runtime = await import('@/sync/domains/server/serverRuntime');
const connection = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const pending = await import('@/sync/domains/pending/pendingTerminalConnect');
const {
    createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries,
} = await import('@/dev/testkit/harness/homeGovernanceHarness');

const CURRENT_URL = 'https://api.happier.dev';
const CURRENT_ID = 'srv_home_current';
type Home = Readonly<{ id: string; url: string; identity: string; credentials: AuthCredentials | null }>;
let boundary: ReturnType<typeof createHomeGovernanceHarness>;
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let homes: Home[];

function keyedCredentials(account: string, byte = 7): AuthCredentials {
    const machineKey = new Uint8Array(32).fill(byte);
    return { token: createAccountTokenForTests(account, { currentAccount: true }), encryption: {
        machineKey: Buffer.from(machineKey).toString('base64'),
        publicKey: Buffer.from(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey).toString('base64'),
    } };
}
function legacyCredentials(account: string, byte = 6): AuthCredentials {
    return { token: createAccountTokenForTests(account, { currentAccount: true }),
        secret: Buffer.from(new Uint8Array(32).fill(byte)).toString('base64') };
}
function tokenCredentials(account = 'plain-account'): AuthCredentials {
    return { token: createAccountTokenForTests(account, { currentAccount: true }) };
}
function descriptor(url = CURRENT_URL, identity = CURRENT_ID): HomeConnectionDescriptorV1 {
    return { v: 1, homeServerIdentityId: identity, canonicalServerUrl: url, revision: 1,
        endpoints: [{ kind: 'https', url }] };
}
function currentness(credentials: AuthCredentials | null, mode: 'plain' | 'e2ee') {
    if (mode === 'plain') return createPlainAccountEncryptionCurrentnessFixture();
    const key = credentials && 'encryption' in credentials
        ? new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        : credentials && 'secret' in credentials
            ? deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(Buffer.from(credentials.secret, 'base64')))
            : new Uint8Array(32).fill(99);
    return AccountEncryptionCurrentnessResponseSchema.parse({
        mode: 'e2ee', version: 1, updatedAt: 1, signingKeyFingerprint: 'signing-key-fingerprint',
        contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey),
        recipientEnvelopeReadiness: { status: 'available' },
    });
}
async function addHome(options: Readonly<{
    url?: string; identity?: string; credentials?: AuthCredentials | null; mode?: 'plain' | 'e2ee';
    publishDescriptor?: boolean; plaintextStorage?: boolean; keylessAccounts?: boolean;
}> = {}): Promise<Home> {
    const url = options.url ?? CURRENT_URL;
    const identity = options.identity ?? CURRENT_ID;
    const credentials = options.credentials === undefined ? null : options.credentials;
    const { parseToken } = await import('@/utils/auth/parseToken');
    const mode = options.mode ?? (credentials && ('encryption' in credentials || 'secret' in credentials) ? 'e2ee' : 'plain');
    const id = await boundary.addHome({
        name: identity, serverUrl: url, serverIdentityId: identity,
        ...(options.publishDescriptor === false ? {} : { publicServerUrl: url }),
        accountId: credentials ? parseToken(credentials.token) : null, ...(credentials ? { credentials } : {}),
        accountEncryptionMode: mode, active: false,
    });
    boundary.answer(id, '/v1/account/encryption/currentness', { body: currentness(credentials, mode) });
    const features = createRootLayoutFeaturesResponse({
        features: {
            encryption: { plaintextStorage: { enabled: options.plaintextStorage ?? true } },
            e2ee: { keylessAccounts: { enabled: options.keylessAccounts ?? true } },
        },
        capabilities: { serverIdentity: { serverIdentityId: identity } },
    });
    boundary.answer(id, '/v1/features', { body: features });
    boundary.answer(id, '/v1/features/authenticated', { body: features });
    boundary.answer(id, '/v1/auth/request/status', { body: { status: 'pending', supportsV2: true } });
    boundary.answer(id, 'POST /v1/auth/response', { body: { success: true } });
    const home = { id, url, identity, credentials };
    homes.push(home);
    return home;
}
async function renderHook(home: Home, options?: Parameters<typeof useConnectTerminal>[0]) {
    if (home.credentials) {
        restored = await restoreServerAccountForTest({
            serverUrl: home.url, serverIdentityId: home.identity, credentials: home.credentials,
            additionalRequestOrigins: homes.map(item => item.url), request: boundary.request,
        });
    } else {
        await runtime.setActiveServer({ serverId: home.id });
        installHomeGovernanceBoundaries(boundary);
    }
    let api: ReturnType<typeof useConnectTerminal> | undefined;
    function Probe() { api = useConnectTerminal(options); return null; }
    await renderScreen(<AuthProvider initialCredentials={home.credentials}><Probe /></AuthProvider>);
    routerReplaceSpy.mockClear();
    routerPushSpy.mockClear();
    modalAlertSpy.mockClear();
    modalAlertAsyncSpy.mockClear();
    modalConfirmSpy.mockClear();
    boundary.requests.length = 0;
    return {
        get api() { return api!; },
        async process(url: string) {
            let result: boolean | undefined;
            await act(async () => { result = await api!.processAuthUrl(url); });
            return result;
        },
    };
}
function pairing(byte = 5) {
    const terminalSecretKey = new Uint8Array(32).fill(byte);
    return {
        terminalSecretKey,
        terminalPublicKey: tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey,
        secret: new Uint8Array(32).fill(12),
        createdAtMs: 1_800_000_000_000,
        expiresAtMs: 1_800_060_000_000,
    };
}
type Pairing = ReturnType<typeof pairing>;
function link(p: Pairing, options: Readonly<{
    url?: string; identity?: string; supportsTokenOnly?: boolean; descriptor?: HomeConnectionDescriptorV1;
}> = {}) {
    const homeDescriptor = options.descriptor ?? descriptor(options.url, options.identity);
    const payload = encodeTerminalConnectLinkV4Payload({
        v: 4, publicKeyB64Url: Buffer.from(p.terminalPublicKey).toString('base64url'),
        pairing: { v: 3, secretB64Url: Buffer.from(p.secret).toString('base64url'),
            createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs,
            homeServerIdentityId: homeDescriptor.homeServerIdentityId, supportsTokenOnly: options.supportsTokenOnly ?? true },
        homeConnectionDescriptor: homeDescriptor,
    });
    return 'happier://terminal?v4=' + payload;
}
function identityLink(p: Pairing, url: string, identity: string) {
    // The local web producer keeps explicit loopback targets that a mobile
    // producer correctly omits; the reader accepts either current carrier.
    return buildTerminalConnectLinks({
        webappUrl: new URL(url).origin, serverUrl: url, serverIdentityId: identity,
        publicKeyB64Url: Buffer.from(p.terminalPublicKey).toString('base64url'),
        pairing: { secretB64Url: Buffer.from(p.secret).toString('base64url'),
            createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs },
        supportsTokenOnly: true,
    }).webUrl;
}
function unboundLink(p: Pairing, url = CURRENT_URL) {
    return 'happier://terminal?key=' + Buffer.from(p.terminalPublicKey).toString('base64url')
        + '&server=' + encodeURIComponent(url);
}
function posts() { return boundary.requestsFor('/v1/auth/response'); }
function approval(home: Home) {
    expect(posts()).toHaveLength(1);
    const request = posts()[0]!;
    expect(request.serverUrl).toBe(new URL(home.url).origin);
    expect(request.token === home.credentials?.token).toBe(true);
    expect(request.input).toMatchObject({ authorizeUnattendedTeamAccess: true });
    expect(request.input).not.toHaveProperty('token');
    return request.input as { publicKey: string; response: string; responseKind: 'dataKey' | 'tokenOnly' };
}
function open(response: string, p: Pairing, secret = p.secret) {
    return openTerminalProvisioningV3Response({
        payload: new Uint8Array(Buffer.from(response, 'base64')), recipientSecretKeyOrSeed: p.terminalSecretKey,
        pairingSecret: secret, terminalEphemeralPublicKey: p.terminalPublicKey,
        createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs, nowMs: p.createdAtMs + 1,
    });
}
async function authority() {
    return {
        active: runtime.getActiveServerSnapshot(),
        profiles: structuredClone(profiles.listServerProfiles()),
        credentials: await Promise.all(homes.map(async home => ({
            id: home.id, value: await TokenStorage.getCredentialsForServerUrl(home.url, { serverId: home.identity }),
        }))),
    };
}
async function pendingAt(home: Home) {
    // Assert focus preservation before this explicit next user action. The real pending
    // owner discloses a pre-auth request only while its own destination is focused.
    await act(async () => { await runtime.setActiveServer({ serverId: home.id }); });
    return pending.getPendingTerminalConnect();
}

beforeEach(async () => {
    await connection.disconnectActiveServerConnection();
    secureStore.clear();
    nativeIroh.enabled = false;
    homes = [];
    boundary = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(boundary);
    pending.clearPendingTerminalConnect();
    modalConfirmSpy.mockReset().mockResolvedValue(true);
    modalAlertAsyncSpy.mockReset().mockImplementation(async (...args) => { modalAlertSpy(...args); });
});
afterEach(async () => {
    standardCleanup();
    pending.clearPendingTerminalConnect();
    await connection.disconnectActiveServerConnection();
    await restored?.dispose();
    restored = undefined;
    await boundary.reset();
    secureStore.clear();
    vi.restoreAllMocks();
});

describe('useConnectTerminal unauthenticated flow', () => {
    it.each([
        ['https', '&server=https%3A%2F%2Fhome.example.test'],
        ['http', '&server=http%3A%2F%2Flan.example.test'],
        ['no-server', ''],
    ])('refuses immutable preview.2 %s pairing without authority mutation', async (_name, server) => {
        const home = await addHome();
        const hook = await renderHook(home);
        const before = await authority();
        expect(await hook.process('happier://terminal?key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
            + server + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1000&expiresAt=61000')).toBe(false);
        expect(modalAlertSpy).toHaveBeenCalledWith('connect.updateRequiredTitle',
            'connect.legacyPairingUpdateRequiredBody', expect.any(Array));
        expect(await authority()).toEqual(before);
        expect(pending.getPendingTerminalConnect()).toBeNull();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(posts()).toHaveLength(0);
        expect(boundary.requests).toHaveLength(0);
    });

    it('honors the real legacy-pairing scan-new-QR reentry action', async () => {
        const hook = await renderHook(await addHome());
        modalAlertAsyncSpy.mockImplementationOnce(async (...args) => {
            modalAlertSpy(...args);
            args[2]?.find(button => button.text === 'connect.scanNewQr')?.onPress?.();
        });
        expect(await hook.process('happier://terminal?key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
            + '&pairingSecret=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'
            + '&createdAt=1000&expiresAt=61000')).toBe(false);
        expect(routerPushSpy).toHaveBeenCalledWith('/scan/terminal');
        expect(posts()).toHaveLength(0);
    });

    it('preserves the strict V4 descriptor while redirecting to sign-in', async () => {
        const home = await addHome();
        const hook = await renderHook(home);
        nativeIroh.enabled = true;
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            return boundary.request(url.origin === 'http://127.0.0.1:48124'
                ? new URL(url.pathname + url.search, CURRENT_URL).toString() : input, init);
        });
        const strict: HomeConnectionDescriptorV1 = { ...descriptor(),
            endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] };
        expect(await hook.process(link(pairing(), { descriptor: strict }))).toBe(false);
        expect(pending.getPendingTerminalConnect()).toMatchObject({
            serverIdentityId: CURRENT_ID, homeConnectionDescriptor: strict,
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith(buildTerminalConnectAuthRedirectHref({ serverUrl: CURRENT_URL }));
        expect(posts()).toHaveLength(0);
    });

    it('keeps a declined strict V4 target bound without redirecting through the active Home', async () => {
        const focused = await addHome({ url: 'https://lan.example.test:53288' });
        const target = await addHome({ url: 'http://127.0.0.1:3005', identity: 'srv_loopback_target', publishDescriptor: false });
        const hook = await renderHook(focused, { allowLoopbackServerOverride: true });
        const strict: HomeConnectionDescriptorV1 = { ...descriptor(target.url, target.identity),
            endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64) }] };
        const before = await authority();
        expect(await hook.process(link(pairing(), { descriptor: strict }))).toBe(false);
        expect(await authority()).toEqual(before);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('welcome.serverUnavailableTitle', 'welcome.serverUnavailableBody', expect.any(Array));
        expect(await pendingAt(target)).toMatchObject({ serverUrl: target.url, homeConnectionDescriptor: strict });
        expect(posts()).toHaveLength(0);
    });

    it('stores pending connect intent and routes to sign-in', async () => {
        const home = await addHome();
        const hook = await renderHook(home);
        const before = await authority();
        const request = pairing();
        expect(await hook.process(identityLink(request, home.url, home.identity))).toBe(false);
        expect(pending.getPendingTerminalConnect()).toMatchObject({
            publicKeyB64Url: Buffer.from(request.terminalPublicKey).toString('base64url'),
            serverUrl: CURRENT_URL, serverIdentityId: CURRENT_ID,
        });
        expect(modalAlertSpy).toHaveBeenCalledWith('terminal.connectTerminal', 'modals.pleaseSignInFirst', [{ text: 'common.continue' }]);
        expect(routerReplaceSpy).toHaveBeenCalledWith(buildTerminalConnectAuthRedirectHref({ serverUrl: CURRENT_URL }));
        expect(await authority()).toEqual(before);
    });

    it('preserves focus while redirecting an unauthenticated explicit target', async () => {
        const focused = await addHome({ url: 'http://127.0.0.1:52753', publishDescriptor: false });
        const target = await addHome({ url: 'https://stack.example.test', identity: 'srv_stack' });
        const hook = await renderHook(focused);
        const before = await authority();
        expect(await hook.process(identityLink(pairing(), target.url, target.identity))).toBe(false);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(await authority()).toEqual(before);
        expect(routerReplaceSpy).toHaveBeenCalledWith(buildTerminalConnectAuthRedirectHref({ serverUrl: target.url }));
        expect(await pendingAt(target)).toMatchObject({ serverUrl: target.url });
    });

    it('does not refresh or reuse focused auth for an unknown explicit target', async () => {
        const focused = await addHome({ credentials: keyedCredentials('focused-account') });
        const hook = await renderHook(focused);
        modalConfirmSpy.mockResolvedValueOnce(false);
        const before = await authority();
        // Unlike the old impossible AuthContext/stored-token split, this is a genuinely
        // signed-in Home and a destination with no credential. Declining preserves both.
        expect(await hook.process(unboundLink(pairing(), 'https://unknown.example.test'))).toBe(false);
        expect(posts()).toHaveLength(0);
        expect(await authority()).toEqual(before);
        // The focused signed-in Home keeps syncing as itself; nothing may reach the unknown destination.
        expect(boundary.requests.filter(request => request.token !== null && request.serverUrl !== focused.url)).toHaveLength(0);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(pending.getPendingTerminalConnect()).toBeNull();
    });

    it('does not switch when the link URL is loopback-equivalent to the applied Home', async () => {
        const home = await addHome({ url: 'https://happier-stack.localhost:3121',
            credentials: keyedCredentials('loopback-account'), publishDescriptor: false });
        const hook = await renderHook(home, { allowLoopbackServerOverride: true });
        const before = await authority();
        expect(await hook.process(link(pairing(), { url: 'https://localhost:3121' }))).toBe(true);
        approval(home);
        expect(await authority()).toEqual(before);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['http://127.0.0.1:43005', 'http://127.0.0.1:3005'],
        ['https://lan.example.test:53288', 'http://localhost:53288'],
    ])('keeps a current URL-only request on focused %s when its loopback override is not allowed', async (focusedUrl, requestedUrl) => {
        const home = await addHome({ url: focusedUrl, publishDescriptor: false });
        const hook = await renderHook(home);
        const before = await authority();
        expect(await hook.process(identityLink(pairing(), requestedUrl, home.identity))).toBe(false);
        expect(await authority()).toEqual(before);
        expect(pending.getPendingTerminalConnect()).toMatchObject({ serverUrl: focusedUrl, serverIdentityId: home.identity });
        expect(routerReplaceSpy).toHaveBeenCalledWith(buildTerminalConnectAuthRedirectHref({ serverUrl: focusedUrl }));
        expect(posts()).toHaveLength(0);
    });

    it.each([CURRENT_URL, 'http://127.0.0.1:3005', 'http://localhost:53288'])(
        'does not retain an identityless unbound request for %s or disclose credentials', async requestedUrl => {
            const home = await addHome();
            const hook = await renderHook(home);
            const before = await authority();
            expect(await hook.process(unboundLink(pairing(), requestedUrl))).toBe(false);
            expect(pending.getPendingTerminalConnect()).toBeNull();
            expect(posts()).toHaveLength(0);
            expect(await authority()).toEqual(before);
            expect(boundary.requests.filter(request => request.token !== null)).toHaveLength(0);
        },
    );

    // P03-MOBILE-FIX: the outcome alert waits for the person indefinitely; the connecting spinner must not keep
    // animating under it (iOS: a native-driven loop on the main thread for as long as the alert stays open).
    it('settles the connecting state before the success alert waits for the person', async () => {
        const home = await addHome({ credentials: keyedCredentials('keyed-account') });
        const hook = await renderHook(home);
        let release!: () => void;
        modalAlertAsyncSpy.mockImplementationOnce(async (...args) => {
            modalAlertSpy(...args);
            await new Promise<void>((resolve) => { release = resolve; });
        });
        let done!: Promise<boolean>;
        await act(async () => { done = hook.api.processAuthUrl(link(pairing())); });
        await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.success', 'modals.terminalConnectedSuccessfully', expect.anything()));
        await act(async () => {});
        expect(hook.api.isLoading).toBe(false);
        await act(async () => { release(); await done; });
    });

    it('seals pairing-bound v3 dataKey bytes and posts only to the explicit target', async () => {
        const home = await addHome({ credentials: keyedCredentials('keyed-account') });
        const hook = await renderHook(home);
        const p = pairing();
        const before = await authority();
        expect(await hook.process(link(p))).toBe(true);
        const body = approval(home);
        expect(body.publicKey).toBe(Buffer.from(p.terminalPublicKey).toString('base64'));
        expect(body.responseKind).toBe('dataKey');
        expect(openTerminalProvisioningV3Payload({
            payload: new Uint8Array(Buffer.from(body.response, 'base64')), recipientSecretKeyOrSeed: p.terminalSecretKey,
            pairingSecret: p.secret, terminalEphemeralPublicKey: p.terminalPublicKey,
            createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs, nowMs: p.createdAtMs + 1,
        })).toEqual(new Uint8Array(32).fill(7));
        expect(await authority()).toEqual(before);
    });

    it('fails closed without posting when a dataKey link has no authenticated pairing context', async () => {
        const home = await addHome({ credentials: keyedCredentials('unbound-account') });
        const hook = await renderHook(home);
        const before = await authority();
        expect(await hook.process(unboundLink(pairing()))).toBe(false);
        expect(posts()).toHaveLength(0);
        expect(await authority()).toEqual(before);
    });

    it('authenticates a v3 response with the QR-only pairing secret', async () => {
        const home = await addHome({ credentials: keyedCredentials('qr-secret-account') });
        const hook = await renderHook(home);
        const p = pairing();
        expect(await hook.process(link(p))).toBe(true);
        const body = approval(home);
        expect(open(body.response, p)).toEqual({ type: 'dataKey', key: new Uint8Array(32).fill(7) });
        expect(open(body.response, p, new Uint8Array(32).fill(13))).toBeNull();
    });

    it('provisions token-only credentials only as authenticated v3 after real plain policy is proven', async () => {
        const home = await addHome({ credentials: tokenCredentials() });
        const hook = await renderHook(home);
        const p = pairing();
        expect(await hook.process(link(p))).toBe(true);
        const body = approval(home);
        expect(body.responseKind).toBe('tokenOnly');
        expect(open(body.response, p)).toEqual({ type: 'tokenOnly' });
        const reads = boundary.requestsFor('/v1/account/encryption/currentness');
        // The signed-in Home's own sync also reads currentness; every read is as that Account.
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(read => read.token === home.credentials?.token)).toBe(true);
        expect(boundary.requestsFor('/v1/features').length).toBeGreaterThan(0);
    });

    it.each([
        { name: 'the QR has no authenticated pairing context', withPairing: false, supportsTokenOnly: true },
        { name: 'the reader did not advertise token-only support', withPairing: true, supportsTokenOnly: false },
        { name: 'the authenticated Account is E2EE', withPairing: true, supportsTokenOnly: true, mode: 'e2ee' as const },
        { name: 'a required feature is disabled', withPairing: true, supportsTokenOnly: true, plaintextStorage: false },
    ])('fails closed for token-only pairing when $name', async fixture => {
        const home = await addHome({ credentials: tokenCredentials(), mode: fixture.mode ?? 'plain',
            plaintextStorage: fixture.plaintextStorage });
        const hook = await renderHook(home);
        const before = await authority();
        const p = pairing();
        expect(await hook.process(fixture.withPairing ? link(p, { supportsTokenOnly: fixture.supportsTokenOnly }) : unboundLink(p))).toBe(false);
        expect(posts()).toHaveLength(0);
        expect(await authority()).toEqual(before);
    });

    it('uses the parsed Home credentials without changing the focused Home', async () => {
        const focused = await addHome({ credentials: keyedCredentials('focused-account') });
        const target = await addHome({ url: 'https://stack.example.test', identity: 'srv_home_b',
            credentials: keyedCredentials('target-account', 11) });
        const hook = await renderHook(focused);
        const p = pairing(8);
        const before = await authority();
        expect(await hook.process(identityLink(p, target.url, target.identity))).toBe(true);
        const body = approval(target);
        expect(body.responseKind).toBe('dataKey');
        expect(open(body.response, p))
            .toEqual({ type: 'dataKey', key: new Uint8Array(32).fill(11) });
        expect(await authority()).toEqual(before);
        // The focused Home keeps its own sync traffic; what carries the target's credential stays on the target.
        expect(boundary.requests.filter(request => request.token === target.credentials?.token)
            .every(request => request.serverUrl === target.url)).toBe(true);
    });

    it('does not disclose focused credentials when the same URL names another Home identity', async () => {
        const home = await addHome({ url: 'https://shared.example.test', identity: 'srv_focused',
            credentials: keyedCredentials('focused-account') });
        const hook = await renderHook(home);
        modalConfirmSpy.mockResolvedValueOnce(false);
        const before = await authority();
        expect(await hook.process(identityLink(pairing(), home.url, 'srv_expected_other'))).toBe(false);
        expect(posts()).toHaveLength(0);
        // The focused Home keeps its own sync traffic; none of it may be an auth approval request.
        expect(boundary.requests.filter(request => request.token !== null && request.path.startsWith('/v1/auth'))).toHaveLength(0);
        expect(await authority()).toEqual(before);
    });

    it('provisions the derived Account content key for legacy credentials, never the recovery secret', async () => {
        const home = await addHome({ credentials: legacyCredentials('legacy-account') });
        const hook = await renderHook(home);
        const p = pairing(6);
        expect(await hook.process(link(p))).toBe(true);
        const body = approval(home);
        expect(body.responseKind).toBe('dataKey');
        const opened = open(body.response, p);
        expect(opened).toEqual({ type: 'dataKey', key: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(6)) });
        expect(opened).not.toEqual({ type: 'dataKey', key: new Uint8Array(32).fill(6) });
        expect(opened).not.toEqual({ type: 'dataKey', key: new Uint8Array(32).fill(7) });
    });

    it('keeps an unverified explicit loopback target pending without approving the saved Home at another host', async () => {
        const home = await addHome({ url: 'https://stack-host.example.test:53288', identity: 'srv_stack_home',
            credentials: keyedCredentials('stack-account', 11) });
        const target = await addHome({ url: 'http://localhost:53288', identity: 'srv_other_saved_target', publishDescriptor: false });
        const hook = await renderHook(home, { allowLoopbackServerOverride: true });
        const before = await authority();
        expect(await hook.process(identityLink(pairing(4), target.url, home.identity))).toBe(false);
        expect(posts()).toHaveLength(0);
        // URL-only sign-in advice does not adopt or focus a Home. The explicit next
        // user focus below verifies that the retained intent still names that URL.
        expect(await authority()).toEqual(before);
        expect(routerReplaceSpy).toHaveBeenCalledWith(buildTerminalConnectAuthRedirectHref({ serverUrl: target.url }));
        expect(await pendingAt(target)).toMatchObject({ serverUrl: target.url, serverIdentityId: home.identity });
    });

    it('approves an identity-bearing URL-only link for an applied Home that publishes no descriptor', async () => {
        const home = await addHome({
            url: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
            identity: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
            credentials: keyedCredentials('loopback-home-account', 13), publishDescriptor: false,
        });
        const hook = await renderHook(home, { allowLoopbackServerOverride: true });
        const before = await authority();
        expect(profiles.buildHomeConnectionDescriptorForProfile(profiles.getServerProfileById(home.id)!)).toBeNull();
        expect(await hook.process(identityLink(pairing(2), 'http://127.0.0.1:53288', home.identity))).toBe(true);
        approval(home);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(await authority()).toEqual(before);
    });

    it('names both Homes and leaves nothing pending when an authenticated user declines the switch', async () => {
        const home = await addHome({ credentials: keyedCredentials('focused-account') });
        const hook = await renderHook(home, { allowLoopbackServerOverride: true });
        modalConfirmSpy.mockResolvedValueOnce(false);
        const before = await authority();
        pending.setPendingTerminalConnect({ publicKeyB64Url: 'previous-request', serverUrl: home.url, serverIdentityId: home.identity });
        expect(pending.getPendingTerminalConnect()).not.toBeNull();
        expect(await hook.process(identityLink(pairing(3), 'https://other-home.example.test', 'srv_other_home'))).toBe(false);
        expect(modalConfirmSpy).toHaveBeenCalledWith('terminal.connectTerminal',
            'terminal.switchServerToConnectTerminal', expect.objectContaining({ confirmText: 'server.switchToServer' }));
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(pending.getPendingTerminalConnect()).toBeNull();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(posts()).toHaveLength(0);
        expect(await authority()).toEqual(before);
    });
});

describe('useConnectTerminal real approval outcomes', () => {
    it.each(['unavailable', 'obsolete-key'] as const)('refuses currentness %s before issuing a sealed response', async failure => {
        const home = await addHome({ credentials: keyedCredentials('currentness-account') });
        const onError = vi.fn();
        // Sign in with valid currentness first; the failure belongs to terminal approval, not fixture authentication.
        const hook = await renderHook(home, { onError });
        boundary.answer(home.id, '/v1/account/encryption/currentness', failure === 'unavailable'
            ? { status: 404, body: { error: 'not_found' } }
            : { body: currentness(keyedCredentials('currentness-account', 10), 'e2ee') });
        const before = await authority();
        expect(await hook.process(link(pairing()))).toBe(false);
        expect(posts()).toHaveLength(0);
        expect(boundary.requests.filter(request => request.path.startsWith('/v1/auth/request/status'))).toHaveLength(0);
        expect(onError).toHaveBeenCalledOnce();
        if (failure === 'unavailable') expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'account-encryption-currentness-unavailable' });
        expect(await authority()).toEqual(before);
    });

    it('does not issue or mutate authority when the Home rejects the request-status read', async () => {
        const home = await addHome({ credentials: keyedCredentials('rejected-request-account') });
        boundary.answer(home.id, '/v1/auth/request/status', { status: 403, body: { error: 'forbidden' } });
        const onSuccess = vi.fn();
        const hook = await renderHook(home, { onSuccess });
        const before = await authority();
        expect(await hook.process(link(pairing()))).toBe(false);
        expect(posts()).toHaveLength(0);
        expect(onSuccess).not.toHaveBeenCalled();
        expect(await authority()).toEqual(before);
    });

    it.each([
        { status: 'pending', result: true, title: 'common.success', message: 'modals.terminalConnectedSuccessfully' },
        { status: 'authorized', result: false, title: 'modals.terminalAlreadyConnected', message: 'modals.terminalConnectionAlreadyUsedDescription' },
        { status: 'not_found', result: false, title: 'modals.authRequestExpired', message: 'modals.authRequestExpiredDescription' },
    ])('projects the Home request status $status without unintended approval', async fixture => {
        const home = await addHome({ credentials: keyedCredentials('outcome-account') });
        boundary.answer(home.id, '/v1/auth/request/status', { body: { status: fixture.status, supportsV2: true } });
        const onSuccess = vi.fn();
        const hook = await renderHook(home, { onSuccess });
        expect(await hook.process(link(pairing()))).toBe(fixture.result);
        expect(modalAlertSpy).toHaveBeenCalledWith(fixture.title, fixture.message, [{ text: 'common.ok' }]);
        expect(onSuccess).toHaveBeenCalledTimes(fixture.result ? 1 : 0);
        expect(posts()).toHaveLength(fixture.result ? 1 : 0);
        expect(pending.getPendingTerminalConnect()).toBeNull();
    });
});
