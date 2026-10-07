import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { adoptHomeProfile, getActiveServerId, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider, getCurrentAuth } from '@/auth/context/AuthContext';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { consumeAccountServiceOAuthReturn } from '@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn';
import { router } from 'expo-router';
import OAuthProviderReturn from './[provider]';
import MtlsCallbackScreen from '../mtls';
import { Modal } from '@/modal';
import { t } from '@/text';
import { executeHomeAuthentication } from '@/auth/flows/executeHomeAuthentication';
import TeamSignInRoute from '../teams/[teamId]/sign-in';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn(), params: {
    provider: 'github', flow: 'auth', pending: 'provider-handle', purpose: '', admissionReference: '', accountMode: 'plain', code: 'mtls-code', error: '',
    teamId: '', target: '',
} }));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    createServerFetchAtEndpoint: (target: { endpointUrl: string; runtimeOrigin?: string }) => (path: string, init?: RequestInit) => boundary.request(target.endpointUrl, path, init, target.runtimeOrigin),
    serverFetch: (path: string, init?: RequestInit) => boundary.request('ambient', path, init),
}));
vi.mock('expo-router', async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    useLocalSearchParams: () => boundary.params,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restore: (() => void) | undefined;
let createdCredentialTarget: Readonly<{ serverUrl: string; serverId: string }> | undefined;
afterEach(async () => {
    await screen?.unmount();
    screen = undefined;
    if (createdCredentialTarget) {
        await TokenStorage.removeCredentialsForServerUrl(createdCredentialTarget.serverUrl, { serverId: createdCredentialTarget.serverId });
        createdCredentialTarget = undefined;
    }
    restore?.();
    boundary.params.provider = 'github';
    boundary.params.flow = 'auth';
    boundary.params.pending = 'provider-handle';
    boundary.params.purpose = '';
    boundary.params.admissionReference = '';
    boundary.params.accountMode = 'plain';
    boundary.params.code = 'mtls-code';
    boundary.params.error = '';
    boundary.params.teamId = '';
    boundary.params.target = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

async function mountTeamEntry() {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(home.id, { scope: 'device' });
    const credentials = { token: fixture.token };
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
    createdCredentialTarget = { serverUrl: home.serverUrl, serverId: home.id };
    boundary.params.teamId = 'team-1';
    boundary.params.target = fixture.home.homeServerIdentityId;
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path === '/v1/auth/ping') return new Response(JSON.stringify({ ok: true }));
        if (path === '/v1/auth/entry' && JSON.parse(String(init?.body)).scope.kind === 'team') {
            return new Response(JSON.stringify({
                v: 1, state: 'admission_required', scope: { kind: 'team' },
                home: { serverId: fixture.home.homeServerIdentityId, displayName: 'Home B', storageMode: 'plain', hosting: null },
                team: { teamId: 'team-1', name: 'Team One', logo: null },
                signInService: { v: 1, mode: 'external', endpoint: fixture.service.endpointUrl,
                    expectedServerIdentityId: fixture.service.serverIdentityId },
                actions: [{ kind: 'authenticate', methodId: 'oidc-team', action: 'connect', mode: 'keyless',
                    origin: 'team', presentation: { displayName: 'Team SSO', providerKind: 'oidc' } },
                    { kind: 'switch_account' }], autoRedirect: null,
            } satisfies AuthEntryProjectionV1));
        }
        if (path.startsWith('/v1/auth/external/oidc-team/params?')
            || path.startsWith('/v1/connect/external/oidc-team/params?')) {
            return new Response(JSON.stringify({ url: 'https://idp.example/authorize',
                purpose: 'team_admission', teamId: 'team-1', admissionReference: 'team-attempt' }));
        }
        return fixture.request(endpoint, path, init);
    });
    // Authenticated entry uses the exact Account request authority, whose final
    // HTTP boundary is fetch rather than the anonymous endpoint client above.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return await boundary.request(url.origin, `${url.pathname}${url.search}`, init);
    }));
    screen = await renderScreen(<AuthProvider initialCredentials={credentials}><TeamSignInRoute /></AuthProvider>);
    return { fixture, home, credentials };
}

async function pressEntryCard(testID: string) {
    await vi.waitFor(() => expect(screen?.findByTestId(testID), JSON.stringify({
        wanted: testID, rendered: screen?.getTextContent(), requests: boundary.request.mock.calls.map(([endpoint, path]) => [endpoint, path]),
    })).toBeTruthy());
    await screen!.pressByTestIdAsync(testID);
}

it.each(['current', 'another'] as const)('starts the selected %s Account Team flow without replacing the saved credential', async (accountSelection) => {
    const { home, credentials } = await mountTeamEntry();
    if (accountSelection === 'another') await pressEntryCard('team-auth-entry-use-another-account');
    await pressEntryCard('team-auth-entry-action:oidc-team');
    const assign = vi.fn();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: { location: { assign } }, configurable: true, writable: true });
    try {
        await pressEntryCard('home-auth-oidc-team-connect-keyless');
        expect(assign).toHaveBeenCalledWith('https://idp.example/authorize');
        const starts = boundary.request.mock.calls.filter(([, path]) => String(path).includes('/external/oidc-team/params?'));
        expect(starts.map(([, path]) => String(path).split('?')[0])).toEqual([
            accountSelection === 'another' ? '/v1/auth/external/oidc-team/params' : '/v1/connect/external/oidc-team/params',
        ]);
        if (accountSelection === 'another') {
            expect(await TokenStorage.getPendingExternalAuth()).toMatchObject({ provider: 'oidc-team',
                teamContinuation: { teamId: 'team-1', admissionReference: 'team-attempt' } });
            expect(await TokenStorage.getPendingExternalConnect()).toBeNull();
        } else {
            expect(await TokenStorage.getPendingExternalAuth()).toBeNull();
            expect(await TokenStorage.getPendingExternalConnect()).toMatchObject({ provider: 'oidc-team',
                returnTo: '/teams/team-1/sign-in?target=srv_home_b', serverUrl: home.serverUrl, serverId: home.id });
        }
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual(credentials);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete (globalThis as { window?: unknown }).window;
    }
});

it('keeps the exact Team return when handing authentication to the Home-selected Account Service', async () => {
    const { fixture } = await mountTeamEntry();
    await pressEntryCard('team-auth-entry-account-service');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/homes/sign-in',
        params: {
            accountEntryReturnTo: `/teams/team-1/sign-in?target=${encodeURIComponent(fixture.home.homeServerIdentityId)}`,
            accountServiceEndpoint: fixture.service.endpointUrl,
            accountServiceIdentity: fixture.service.serverIdentityId,
            accountIntent: JSON.stringify({ kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: fixture.home.homeServerIdentityId } }),
        } });
});

it.each(['access_denied', 'oauth_not_configured'])('returns a failed Team connect to its bound Team after %s', async (error) => {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    const returnTo = `/teams/team-1/sign-in?target=${encodeURIComponent(fixture.home.homeServerIdentityId)}`;
    await TokenStorage.setPendingExternalConnect({ provider: 'github', returnTo,
        serverId: home.id, serverUrl: home.serverUrl });
    boundary.params.flow = 'connect';
    boundary.params.error = error;
    boundary.request.mockRejectedValue(new Error('A canceled connect must not finalize'));
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(returnTo));
    expect(await TokenStorage.getPendingExternalConnect()).toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
});

it('returns canceled fresh Team authentication to its stored Team continuation', async () => {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'team-proof',
        serverUrl: home.serverUrl, serverId: fixture.home.homeServerIdentityId,
        teamContinuation: {
            v: 1, purpose: 'team_admission', admissionReference: 'team-attempt',
            teamId: 'team-1', homeServerIdentityId: fixture.home.homeServerIdentityId,
            destination: { kind: 'team_sign_in', teamId: 'team-1' },
        },
    }, { serverUrl: home.serverUrl, serverId: fixture.home.homeServerIdentityId });
    boundary.params.flow = 'auth';
    boundary.params.error = 'access_denied';
    boundary.request.mockRejectedValue(new Error('Canceled authentication must not finalize'));
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(
        `/teams/team-1/sign-in?target=${encodeURIComponent(fixture.home.homeServerIdentityId)}`,
    ));
    expect(await TokenStorage.getPendingExternalAuth()).toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
});

it('rejects a Team callback whose admission reference does not match its pending continuation', async () => {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({
        descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory',
        descriptorAuthority: 'current_connection_observation',
    });
    await setActiveServerId(home.id, { scope: 'device' });
    boundary.params.provider = 'github';
    boundary.params.flow = 'auth';
    boundary.params.pending = 'provider-handle';
    boundary.params.purpose = 'team_admission';
    boundary.params.admissionReference = 'returned-admission-reference';
    boundary.params.accountMode = 'plain';
    boundary.params.error = '';
    await expect(TokenStorage.setPendingExternalAuth({
        provider: 'github',
        proof: 'proof-b',
        serverUrl: home.serverUrl,
        serverId: fixture.home.connectionDescriptor.homeServerIdentityId,
        teamContinuation: {
            v: 1,
            purpose: 'team_admission',
            admissionReference: 'expected-admission-reference',
            teamId: 'team-1',
            homeServerIdentityId: fixture.home.connectionDescriptor.homeServerIdentityId,
            destination: { kind: 'team_sign_in', teamId: 'team-1' },
        },
    }, {
        serverUrl: home.serverUrl,
        serverId: fixture.home.connectionDescriptor.homeServerIdentityId,
    })).resolves.toBe(true);
    await expect(TokenStorage.readPendingExternalAuthContinuationState()).resolves.toMatchObject({
        serverMismatch: false,
        value: {
            provider: 'github',
            teamContinuation: {
                admissionReference: 'expected-admission-reference',
            },
        },
    });
    boundary.request.mockRejectedValue(new Error('A mismatched callback must not reach finalization'));

    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);

    await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(
        t('common.error'),
        t('errors.oauthStateMismatch'),
    ));
    expect(boundary.request).not.toHaveBeenCalled();
    expect(await TokenStorage.getPendingExternalAuth()).toBeNull();
    expect(router.replace).toHaveBeenCalledWith(
        `/teams/team-1/sign-in?target=${encodeURIComponent(fixture.home.connectionDescriptor.homeServerIdentityId)}`,
    );
});

it('names a dynamic provider on its OAuth return by the presentation its Home projected at start', async () => {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({
        descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory',
        descriptorAuthority: 'current_connection_observation',
    });
    await setActiveServerId(home.id, { scope: 'device' });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => (
        path.startsWith('/v1/auth/external/oidc-northwind/params?')
            ? new Response(JSON.stringify({ url: 'https://idp.northwind.example/authorize?state=northwind' }))
            : fixture.request(endpoint, path, init)
    ));
    // The browser is the one boundary the start hands off to.
    const assign = vi.fn();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: { location: { assign } }, configurable: true, writable: true });
    try {
        const target = { kind: 'descriptor', authority: 'current_connection', descriptor: fixture.home.connectionDescriptor } as const;
        await executeHomeAuthentication({
            request: {
                method: {
                    id: 'oidc-northwind',
                    enabledActions: [{ id: 'login', mode: 'keyless' }],
                    presentation: { displayName: 'Northwind Workforce', providerKind: 'oidc' },
                },
                action: { id: 'login', mode: 'keyless' },
                execution: { kind: 'oauth', providerId: 'oidc-northwind', mode: 'keyless' },
                authority: { purpose: 'home', target },
                intendedHome: target,
            },
            loginWithCredentials: async () => { throw new Error('An OAuth start commits no credential'); },
            returnTo: '/setup/wizard',
        });
        expect(assign).toHaveBeenCalledWith('https://idp.northwind.example/authorize?state=northwind');
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete (globalThis as { window?: unknown }).window;
    }

    // A fresh load of the return route holds no Home projection: only the start's
    // custody can name this provider the way its Home does.
    boundary.params.provider = 'oidc-northwind';
    boundary.params.flow = 'auth';
    boundary.params.pending = '';
    boundary.params.error = 'oauth_not_configured';
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);

    await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(
        t('common.error'),
        t('friends.providerGate.notConfigured', { provider: 'Northwind Workforce' }),
    ));
});

it.each(['oauth', 'mtls-claim', 'mtls-redirect', 'mtls-web'] as const)('presents a disabled Account on its captured Home after %s proof without committing credentials', async (flow) => {
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const homeA = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor,
        homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test',
        endpoints: [{ kind: 'https', url: 'https://home-a.test' }] }, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    const homeB = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(homeA.id, { scope: 'device' });
    const activeHomeA = getActiveServerId();
    boundary.params.accountMode = 'plain';
    boundary.params.error = flow === 'mtls-redirect' ? 'account-disabled' : '';
    boundary.params.code = flow === 'mtls-redirect' ? '' : 'mtls-code';
    const provider = flow === 'oauth' ? 'github' : 'mtls';
    await TokenStorage.setPendingExternalAuth({ provider, proof: 'proof-b', serverUrl: homeB.serverUrl,
        serverId: 'srv_home_b', returnTo: '/setup/wizard' }, { serverUrl: homeB.serverUrl, serverId: 'srv_home_b' });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path === '/v1/auth/external/github/finalize-keyless' || path === '/v1/auth/mtls/claim' || path === '/v1/auth/mtls') {
            expect(endpoint).toBe(homeB.serverUrl);
            return new Response(JSON.stringify({ error: 'account-disabled', message: 'private diagnostics' }), { status: 403 });
        }
        return fixture.request(endpoint, path, init);
    });
    screen = await renderScreen(<AuthProvider initialCredentials={null}>{flow === 'mtls-web' ? <></>
        : provider === 'mtls' ? <MtlsCallbackScreen /> : <OAuthProviderReturn />}</AuthProvider>);
    if (flow === 'mtls-web') {
        const target = { kind: 'descriptor', authority: 'current_connection', descriptor: fixture.home.connectionDescriptor } as const;
        await executeHomeAuthentication({
            request: {
                method: { id: 'mtls', enabledActions: [{ id: 'login', mode: 'keyless' }] },
                action: { id: 'login', mode: 'keyless' }, execution: { kind: 'mtls' },
                authority: { purpose: 'home', target }, intendedHome: target,
            },
            loginWithCredentials: async () => { throw new Error('Failed proof cannot commit credentials'); },
            returnTo: '/setup/wizard',
        });
    }
    await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(t('common.error'), t('errors.accountDisabled', { home: homeB.serverUrl })));
    expect(getActiveServerId()).toBe(activeHomeA);
    expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: 'srv_home_b' })).toBeNull();
    expect(getCurrentAuth()?.credentials).toBeNull();
});

it.each([
    { provider: 'github', superseded: false, restoreRequired: false, accountCredentialReplaced: false },
    { provider: 'mtls', superseded: false, restoreRequired: false, accountCredentialReplaced: false },
    { provider: 'github', superseded: true, restoreRequired: false, accountCredentialReplaced: false },
    { provider: 'mtls', superseded: true, restoreRequired: false, accountCredentialReplaced: false },
    { provider: 'github', superseded: false, restoreRequired: true, accountCredentialReplaced: false },
    { provider: 'mtls', superseded: false, restoreRequired: true, accountCredentialReplaced: false },
    { provider: 'github', superseded: false, restoreRequired: false, accountCredentialReplaced: true },
    { provider: 'mtls', superseded: false, restoreRequired: false, accountCredentialReplaced: true },
    { provider: 'github', superseded: false, restoreRequired: true, accountCredentialReplaced: true },
    { provider: 'mtls', superseded: false, restoreRequired: true, accountCredentialReplaced: true },
])('preserves exact Home callback custody for $provider (superseded=$superseded, restoreRequired=$restoreRequired, accountCredentialReplaced=$accountCredentialReplaced)', async ({ provider, superseded, restoreRequired, accountCredentialReplaced }) => {
    boundary.params.code = 'mtls-code';
    boundary.params.accountMode = restoreRequired ? 'e2ee' : 'plain';
    boundary.params.error = provider === 'mtls' && restoreRequired ? 'restore_required' : '';
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    fixture.state.homes = [];
    fixture.state.preferredHomeServerIdentityId = null;
    const homeA = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor,
        homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test',
        endpoints: [{ kind: 'https', url: 'https://home-a.test' }] }, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    const homeB = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor,
        endpoints: [{ kind: 'https', url: 'https://home-b-transport.test' }] }, source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    // These table rows intentionally reuse the same canonical Home identity.
    // Clear the exact scope before arranging this row so a successful earlier
    // row cannot masquerade as a credential committed by a superseded or
    // restore-required callback.
    await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: 'srv_home_b' });
    await setActiveServerId(homeA.id, { scope: 'device' });
    const activeHomeA = getActiveServerId();
    const focusChanges: string[] = [];
    const unsubscribeFocus = subscribeActiveServer((snapshot) => { if (snapshot.serverId !== activeHomeA) focusChanges.push(snapshot.serverId); });
    const credentialsA = { token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };
    await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: 'srv_home_a' }, credentialsA);
    const directoryTarget = { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId };
    await TokenStorage.accountDirectoryAuthCredentials.set(directoryTarget, { token: 'directory-token' });
    const continuation = { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
        canonicalServerUrl: fixture.service.canonicalServerUrl, entryIntent: { kind: 'enroll' as const, homeServerIdentityId: 'srv_home_b' },
        homeServerIdentityId: 'srv_home_b', returnTo: '/setup/wizard', accountEntryReturnTo: '/settings/account',
        credentialTokenDigest: 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM' };
    await TokenStorage.setPendingExternalAuth({ provider, proof: 'proof-b', serverUrl: homeB.serverUrl,
        serverId: 'srv_home_b', returnTo: '/setup/wizard', accountContinuation: continuation },
    { serverUrl: homeB.serverUrl, serverId: 'srv_home_b' });
    if (accountCredentialReplaced && restoreRequired) {
        await TokenStorage.accountDirectoryAuthCredentials.set(directoryTarget, { token: 'replacement-directory-token' });
    }
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit, runtimeOrigin?: string) => {
        if (path === '/v1/auth/external/github/finalize-keyless' || path === '/v1/auth/mtls/claim') {
            expect(endpoint).toBe(homeB.serverUrl);
            if (!superseded) expect(runtimeOrigin).toBe('https://home-b-transport.test');
            if (superseded) {
                await TokenStorage.setPendingExternalAuth({ provider, proof: 'replacement-proof', serverUrl: homeB.serverUrl,
                    serverId: 'srv_home_b', returnTo: '/setup/wizard', accountContinuation: continuation },
                { serverUrl: homeB.serverUrl, serverId: 'srv_home_b' });
            }
            if (accountCredentialReplaced && !restoreRequired) {
                await TokenStorage.accountDirectoryAuthCredentials.set(directoryTarget, { token: 'replacement-directory-token' });
            }
            return new Response(JSON.stringify({ token: fixture.token }));
        }
        return fixture.request(endpoint, path, init);
    });
    screen = await renderScreen(<AuthProvider initialCredentials={credentialsA}>{provider === 'mtls' ? <MtlsCallbackScreen /> : <OAuthProviderReturn />}</AuthProvider>);
    if (superseded) {
        try {
            await vi.waitFor(() => expect(boundary.request.mock.calls.some(([, path]) =>
                path === '/v1/auth/external/github/finalize-keyless' || path === '/v1/auth/mtls/claim')).toBe(true));
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
            expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: 'srv_home_b' })).toBeNull();
            expect((await TokenStorage.readPendingExternalAuthContinuationState()).value?.proof).toBe('replacement-proof');
            expect(router.replace).not.toHaveBeenCalled();
            expect(focusChanges).toEqual([]);
        } finally { unsubscribeFocus(); }
        return;
    }
    if (accountCredentialReplaced) {
        if (!restoreRequired) {
            await vi.waitFor(() => expect(boundary.request.mock.calls.some(([, path]) =>
                path === '/v1/auth/external/github/finalize-keyless' || path === '/v1/auth/mtls/claim')).toBe(true));
        }
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(await TokenStorage.accountDirectoryAuthCredentials.get(directoryTarget)).toEqual({ token: 'replacement-directory-token' });
        expect(TokenStorage.readAccountDirectoryOAuthReturn({
            ...directoryTarget,
            intent: continuation.entryIntent,
            invokingSurface: continuation.returnTo,
            accountEntryReturnTo: continuation.accountEntryReturnTo,
        })).toBeNull();
        expect(vi.mocked(router.replace).mock.calls.some(([destination]) =>
            typeof destination === 'object' && destination !== null && 'params' in destination
            && destination.params && typeof destination.params === 'object'
            && 'accountServiceReturn' in destination.params)).toBe(false);
        expect(fixture.state.calls.some(({ path }) => path.startsWith('/v1/account-directory/'))).toBe(false);
        unsubscribeFocus();
        return;
    }
    try {
        await vi.waitFor(() => {
            expect(focusChanges).toEqual([]);
            expect(router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/setup/wizard',
                params: expect.objectContaining({ accountServiceReturn: '1', accountEntryReturnTo: '/settings/account' }) }));
        });
    } finally { unsubscribeFocus(); }
    expect(getActiveServerId()).toBe(activeHomeA);
    expect(getCurrentAuth()?.credentials).toEqual(credentialsA);
    expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: 'srv_home_b' })).toEqual(restoreRequired ? null : { token: fixture.token });
    const destination = vi.mocked(router.replace).mock.calls.at(-1)?.[0];
    if (!destination || typeof destination !== 'object' || !('params' in destination) || !destination.params) throw new Error('Expected sanitized return');
    expect(JSON.stringify(destination)).not.toContain(fixture.token);
    const options = { invokingSurface: '/setup/wizard', signal: new AbortController().signal };
    const returned = await consumeAccountServiceOAuthReturn(destination.params, options);
    expect(returned).toMatchObject({ kind: 'consumed', result: restoreRequired
        ? { kind: 'failure', recovery: 'use_home_auth', targetHomeServerIdentityId: 'srv_home_b', homeCredentialCommitted: false }
        : { kind: 'home_enrolled', homeServerIdentityId: 'srv_home_b' } });
    expect(fixture.state.calls.some(({ path }) => path.startsWith('/v1/account-directory/') || path === '/v1/auth/home-login')).toBe(false);
    expect(await consumeAccountServiceOAuthReturn(destination.params, options)).toEqual({ kind: 'invalid' });
});
