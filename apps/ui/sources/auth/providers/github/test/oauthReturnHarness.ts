import React from 'react';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { TeamLabelEnvelopeWorkV1Schema } from '@happier-dev/protocol/teams';
import { parseToken } from '@/utils/auth/parseToken';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import renderer, { act } from 'react-test-renderer';
import type {
    AuthCredentials,
    PendingAccountDirectoryAuth,
    PendingExternalAuth,
    PendingExternalConnect,
} from '@/auth/storage/tokenStorage';
import { setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';

export const replaceSpy = vi.fn();
export const localSearchParamsMock = vi.fn();
const routerBoundary = vi.hoisted(() => ({ resetParams: () => {} }));

export const getRandomBytesSpy = vi.fn((length = 32) => new Uint8Array(length).fill(9));
const hoistedModal = vi.hoisted(() => ({
    show: vi.fn((config: { onRequestClose?: () => void }) => {
        config.onRequestClose?.();
        return 'modal-id';
    }),
    alert: vi.fn(async () => {}),
    alertAsync: vi.fn(async () => {}),
    prompt: vi.fn<(title: string, message: string, opts: Record<string, unknown>) => Promise<string | null>>(async () => null),
    confirm: vi.fn(async () => true),
}));
export const modal = hoistedModal;
const hoistedWebBrowser = vi.hoisted(() => ({
    maybeCompleteAuthSession: vi.fn<() => {
        type: 'success' | 'failed';
        message: string;
    }>(() => ({
        type: 'failed' as const,
        message: 'No auth session is currently in progress',
    })),
}));
export const maybeCompleteAuthSessionSpy =
    hoistedWebBrowser.maybeCompleteAuthSession;

vi.mock('expo-web-browser', () => ({
    maybeCompleteAuthSession:
        hoistedWebBrowser.maybeCompleteAuthSession,
}));

const nativeStore = vi.hoisted(() => ({ values: new Map<string, string>(), beforeWrite: undefined as ((key: string, value: string) => void | Promise<void>) | undefined }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => nativeStore.values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { await nativeStore.beforeWrite?.(key, value); nativeStore.values.set(key, value); },
    deleteItemAsync: async (key: string) => { nativeStore.values.delete(key); },
}));

export const oauthDefaultHome = { serverId: 'srv_server-a', serverUrl: 'http://default.example.test' };
let preparations = Promise.resolve();
let activeServerSnapshotState = { ...oauthDefaultHome, kind: 'custom', generation: 1 };
let authState: { isAuthenticated: boolean; credentials: AuthCredentials | null } = { isAuthenticated: false, credentials: null };

function prepare(action: () => Promise<unknown>) {
    preparations = preparations.then(async () => { await action(); });
}

async function saveHome(target: Readonly<{ serverId?: string; serverUrl: string }>, active = false) {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const profile = await profiles.upsertServerProfile({ serverUrl: target.serverUrl, source: 'manual' });
    if (target.serverId && !await profiles.setServerProfileIdentityForUrl(target.serverUrl, target.serverId)) {
        throw new Error('Could not seed OAuth Home identity');
    }
    if (active) await profiles.setActiveServerId(target.serverId ?? profile.id, { scope: 'device' });
}

export function setActiveServerSnapshot(next: Partial<typeof activeServerSnapshotState>) {
    activeServerSnapshotState = { ...activeServerSnapshotState, ...next };
    const target = { ...activeServerSnapshotState };
    prepare(() => saveHome(target, true));
}

export function setPendingExternalAuthState(next: PendingExternalAuth | null) {
    prepare(async () => {
        if (next) {
            if (next.serverUrl) await saveHome({ serverUrl: next.serverUrl, ...(next.serverId ? { serverId: next.serverId } : {}) });
            if (!await TokenStorage.setPendingExternalAuth(next, next.serverUrl
                ? { serverUrl: next.serverUrl, ...(next.serverId ? { serverId: next.serverId } : {}) }
                : undefined)) throw new Error('Could not seed pending external authentication');
        } else await TokenStorage.clearPendingExternalAuth();
    });
}

export function setPendingExternalAuthServerMismatch(next: boolean) {
    if (!next) return;
    prepare(async () => {
        const differentHome = { serverId: 'srv_mismatched-home', serverUrl: 'https://mismatched-home.test' };
        await saveHome(differentHome, true);
    });
}

export function setPendingExternalConnectState(next: PendingExternalConnect | null) {
    prepare(async () => {
        if (next) {
            if (next.serverUrl) await saveHome({ serverUrl: next.serverUrl, ...(next.serverId ? { serverId: next.serverId } : {}) });
            if (!await TokenStorage.setPendingExternalConnect(next)) throw new Error('Could not seed pending external connection');
        } else await TokenStorage.clearPendingExternalConnect();
    });
}

export function setPendingAccountDirectoryAuthState(next: (Omit<PendingAccountDirectoryAuth, 'canonicalServerUrl' | 'entryIntent'> & Partial<Pick<PendingAccountDirectoryAuth, 'canonicalServerUrl' | 'entryIntent'>>) | null) {
    const pending: PendingAccountDirectoryAuth | null = next ? { ...next, canonicalServerUrl: next.canonicalServerUrl ?? next.endpoint,
        entryIntent: next.entryIntent ?? { kind: 'enter', target: { kind: 'automatic' } } } : null;
    prepare(async () => {
        if (pending) {
            setAccountServiceEndpoint({ url: pending.endpoint, serverIdentityId: pending.serverIdentityId, source: 'user' });
            if (!await TokenStorage.setPendingAccountDirectoryAuth(pending)) throw new Error('Could not seed Account Service callback');
        } else await TokenStorage.clearPendingAccountDirectoryAuth();
    });
}

export function setStoredCredentialsState(next: AuthCredentials | null, explicitTarget?: { serverId: string; serverUrl: string }) {
    prepare(async () => {
        const pending = await TokenStorage.getPendingExternalConnect();
        const target = explicitTarget ?? (pending?.serverUrl && pending.serverId ? pending : activeServerSnapshotState);
        if (explicitTarget) await saveHome(explicitTarget);
        if (next) {
            if (!await TokenStorage.setCredentialsForServerUrl(target.serverUrl!, { serverId: target.serverId }, next)) {
                throw new Error('Could not seed OAuth credential');
            }
        }
        else await TokenStorage.removeCredentialsForServerUrl(target.serverUrl!, { serverId: target.serverId });
    });
}

export function setAuthState(next: { isAuthenticated: boolean; credentials: AuthCredentials | null }) {
    authState = next;
    if (next.credentials) setStoredCredentialsState(next.credentials);
}

export let clearPendingExternalAuthMock = vi.spyOn(TokenStorage, 'clearPendingExternalAuth');
export let recordTeamInvitationPostAuthContinuationMock = vi.spyOn(TokenStorage, 'recordTeamInvitationPostAuthContinuation');
export let isPendingExternalAuthContinuationCurrentMock = vi.spyOn(TokenStorage, 'isPendingExternalAuthContinuationCurrent');
export let clearPendingExternalConnectMock = vi.spyOn(TokenStorage, 'clearPendingExternalConnect');
export let readPendingExternalAuthStateMock = vi.spyOn(TokenStorage, 'readPendingExternalAuthContinuationState');

export async function prepareOAuthHarness() { await preparations; }
export const oauthNativeStorageBoundary = nativeStore;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace: replaceSpy },
        params: () => localSearchParamsMock(),
    });
    routerBoundary.resetParams = expoRouterMock.resetParams;
    return expoRouterMock.module;
});

vi.mock('@/modal', () => ({ Modal: modal }));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Randomness is an OS boundary. Signing, key derivation and custody stay real.
vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: (length: number) => getRandomBytesSpy(length),
    getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(9),
}));

await initializeAuthRouteRuntimeForTests();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const externalAuth = await import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth');
const directoryAuth = await import('@/auth/accountDirectory/accountDirectoryAuthClient');
const analytics = await import('@/track');
export let trackAccountCreatedSpy = vi.spyOn(analytics, 'trackAccountCreated');
export let trackAccountRestoredSpy = vi.spyOn(analytics, 'trackAccountRestored');
export let resumeAccountEncryptionFirstKeyExternalAuthSpy = vi.spyOn(externalAuth, 'resumeAccountEncryptionFirstKeyExternalAuth');
export let resumeAccountPasswordEnrollmentExternalAuthSpy = vi.spyOn(externalAuth, 'resumeAccountPasswordEnrollmentExternalAuth');
export let cancelAccountPasswordEnrollmentExternalAuthSpy = vi.spyOn(externalAuth, 'cancelAccountPasswordEnrollmentExternalAuth');
export let clearAccountPasswordEnrollmentExternalAuthCustodySpy = vi.spyOn(externalAuth, 'clearAccountPasswordEnrollmentExternalAuthCustody');
export let readAccountPasswordEnrollmentExternalAuthCallbackContextSpy = vi.spyOn(externalAuth, 'readAccountPasswordEnrollmentExternalAuthCallbackContext');
export let accountDirectoryExchangeOAuthSpy = vi.spyOn(directoryAuth.accountDirectoryAuthClient, 'exchangeOAuth');
export let pendingAccountDirectoryAuthClearSpy = vi.spyOn(TokenStorage, 'clearPendingAccountDirectoryAuth');


export function OAuthHarnessProvider({ children }: { children: React.ReactNode }) {
    return React.createElement(AuthProvider, { initialCredentials: authState.credentials, children });
}

export function setOAuthRuntimeFetch(request: RuntimeFetch): RuntimeFetch {
    const boundary: RuntimeFetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
        if (url.pathname === '/v1/account/profile') {
            const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '');
            return Response.json(AccountProfileSchema.parse({ id: token ? parseToken(token) : 'oauth-account' }));
        }
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
        if (url.pathname === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: null, version: 0 }));
        if (url.pathname === '/v2/teams/label-envelopes' && (init?.method ?? 'GET') === 'GET') {
            return Response.json(TeamLabelEnvelopeWorkV1Schema.parse({ teams: [] }));
        }
        if (url.pathname === '/v1/account/encryption' || url.pathname === '/v1/account/encryption/currentness') {
            const credentials = await TokenStorage.getCredentialsForServerUrl(url.origin);
            const currentness = createAccountEncryptionCurrentnessFixtureForCredentials(credentials ?? { token: createAccountTokenForTests('oauth-account') });
            return Response.json(url.pathname.endsWith('/currentness') ? currentness : { mode: currentness.mode, updatedAt: 1 });
        }
        const bootstrap = createEmptyAccountBootstrapHttpResponse(url.pathname + url.search, init);
        return bootstrap ?? await request(input, init);
    };
    setRuntimeFetch(boundary);
    return boundary;
}

export async function flushOAuthEffects(turns = 8): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await act(async () => {});
    }
}

export async function runWithOAuthScreen(
    runAssertions: (tree: ReturnType<typeof renderer.create>) => Promise<void>,
): Promise<void> {
    const tree = await renderOAuthReturnScreen();
    try {
        await runAssertions(tree);
    } finally {
        act(() => {
            tree.unmount();
        });
    }
}

export async function renderOAuthReturnScreen() {
    await prepareOAuthHarness();
    const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
    let tree: ReturnType<typeof renderer.create> | undefined;
    await act(async () => {
        tree = renderer.create(React.createElement(OAuthHarnessProvider, { children: React.createElement(Screen) }));
    });
    await flushOAuthEffects();
    if (!tree) {
        throw new Error('Expected OAuth screen to render');
    }
    return tree;
}

export function resetOAuthHarness() {
    routerBoundary.resetParams();
    replaceSpy.mockClear();
    localSearchParamsMock.mockReset();
    getRandomBytesSpy.mockClear();
    trackAccountCreatedSpy.mockClear();
    trackAccountRestoredSpy.mockClear();
    modal.show.mockClear(); modal.alert.mockClear(); modal.alertAsync.mockClear();
    modal.prompt.mockReset(); modal.prompt.mockResolvedValue(null);
    modal.confirm.mockReset(); modal.confirm.mockResolvedValue(true);
    maybeCompleteAuthSessionSpy.mockReset();
    maybeCompleteAuthSessionSpy.mockReturnValue({ type: 'failed', message: 'No auth session is currently in progress' });
}

const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
afterAll(() => {
    if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
});
afterEach(async () => {
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
});
let sequence = 0;
beforeEach(async () => {
    routerBoundary.resetParams();
    process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `oauth-return-${sequence++}`;
    nativeStore.values.clear();
    nativeStore.beforeWrite = undefined;
    preparations = Promise.resolve();
    authState = { isAuthenticated: false, credentials: null };
    await saveHome(oauthDefaultHome, true);
    activeServerSnapshotState = { ...oauthDefaultHome, kind: 'custom', generation: 1 };
    trackAccountCreatedSpy = vi.spyOn(analytics, 'trackAccountCreated');
    trackAccountRestoredSpy = vi.spyOn(analytics, 'trackAccountRestored');
    clearPendingExternalAuthMock = vi.spyOn(TokenStorage, 'clearPendingExternalAuth');
    recordTeamInvitationPostAuthContinuationMock = vi.spyOn(TokenStorage, 'recordTeamInvitationPostAuthContinuation');
    isPendingExternalAuthContinuationCurrentMock = vi.spyOn(TokenStorage, 'isPendingExternalAuthContinuationCurrent');
    clearPendingExternalConnectMock = vi.spyOn(TokenStorage, 'clearPendingExternalConnect');
    readPendingExternalAuthStateMock = vi.spyOn(TokenStorage, 'readPendingExternalAuthContinuationState');
    resumeAccountEncryptionFirstKeyExternalAuthSpy = vi.spyOn(externalAuth, 'resumeAccountEncryptionFirstKeyExternalAuth');
    resumeAccountPasswordEnrollmentExternalAuthSpy = vi.spyOn(externalAuth, 'resumeAccountPasswordEnrollmentExternalAuth');
    cancelAccountPasswordEnrollmentExternalAuthSpy = vi.spyOn(externalAuth, 'cancelAccountPasswordEnrollmentExternalAuth');
    clearAccountPasswordEnrollmentExternalAuthCustodySpy = vi.spyOn(externalAuth, 'clearAccountPasswordEnrollmentExternalAuthCustody');
    readAccountPasswordEnrollmentExternalAuthCallbackContextSpy = vi.spyOn(externalAuth, 'readAccountPasswordEnrollmentExternalAuthCallbackContext');
    accountDirectoryExchangeOAuthSpy = vi.spyOn(directoryAuth.accountDirectoryAuthClient, 'exchangeOAuth');
    pendingAccountDirectoryAuthClearSpy = vi.spyOn(TokenStorage, 'clearPendingAccountDirectoryAuth');
    for (const observer of [clearPendingExternalAuthMock, recordTeamInvitationPostAuthContinuationMock,
        isPendingExternalAuthContinuationCurrentMock, clearPendingExternalConnectMock, readPendingExternalAuthStateMock,
        resumeAccountEncryptionFirstKeyExternalAuthSpy, resumeAccountPasswordEnrollmentExternalAuthSpy,
        cancelAccountPasswordEnrollmentExternalAuthSpy, clearAccountPasswordEnrollmentExternalAuthCustodySpy,
        readAccountPasswordEnrollmentExternalAuthCallbackContextSpy, accountDirectoryExchangeOAuthSpy, pendingAccountDirectoryAuthClearSpy]) observer.mockClear();
    externalAuth.clearAccountPasswordEnrollmentExternalAuthCustody();
    clearAccountPasswordEnrollmentExternalAuthCustodySpy.mockClear();
    setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    setOAuthRuntimeFetch(async () => new Response('{}', { status: 404 }));
});
