import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { adoptHomeProfile, getActiveServerId, resetServerProfilesRuntimeForTests, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider, getCurrentAuth } from '@/auth/context/AuthContext';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { consumeAccountServiceOAuthReturn } from '@/sync/ops/accountDirectory/consumeAccountServiceOAuthReturn';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { executeHomeAuthentication } from '@/auth/flows/executeHomeAuthentication';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn(), params: {
    provider: 'github', flow: 'auth', pending: 'provider-handle', purpose: '', admissionReference: '', accountMode: 'plain', code: 'mtls-code', error: '', error_description: '',
    teamId: '', target: '', mode: '', credentialTarget: '', endpointUrl: '', endpointServerIdentityId: '', canonicalServerUrl: '',
} }));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(original));
vi.mock('expo-router', async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    useLocalSearchParams: () => boundary.params,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

await initializeAuthRouteRuntimeForTests();
const { default: OAuthProviderReturn } = await import('./[provider]');
const { default: MtlsCallbackScreen } = await import('../mtls');
const { default: TeamSignInRoute } = await import('../teams/[teamId]/sign-in');

beforeEach(() => {
    restore = installLocalStorageMock().restore;
    resetServerProfilesRuntimeForTests();
    // Observe the physical HTTP destination below the real scoped client and carrier policy.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return await boundary.request(url.origin, `${url.pathname}${url.search}`, init);
    });
});

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
    restore = undefined;
    boundary.params.provider = 'github';
    boundary.params.flow = 'auth';
    boundary.params.pending = 'provider-handle';
    boundary.params.purpose = '';
    boundary.params.admissionReference = '';
    boundary.params.accountMode = 'plain';
    boundary.params.code = 'mtls-code';
    boundary.params.error = '';
    boundary.params.error_description = '';
    boundary.params.teamId = '';
    boundary.params.target = '';
    Object.assign(boundary.params, { mode: '', credentialTarget: '', endpointUrl: '', endpointServerIdentityId: '', canonicalServerUrl: '' });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it('waits for the OS browser again when an Account Service return requires keyed authentication', async () => {
    const fixture = createDirectoryHttpFixture();
    const { endpointUrl, serverIdentityId, canonicalServerUrl } = fixture.service;
    const target = { endpoint: endpointUrl, serverIdentityId };
    const entryIntent = { kind: 'enter', target: { kind: 'automatic' } } as const;
    const returnTo = '/setup/wizard';
    const providerId = 'corp-oidc';
    const invoke = vi.fn(createDesktopSecureStorageBoundary().invoke);
    onTestFinished(installWebLockManagerMock().restore);
    vi.stubGlobal('HTMLElement', class {});
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    Object.assign(boundary.params, {
        provider: providerId, mode: 'keyless', purpose: 'account_directory', credentialTarget: 'account_directory',
        endpointUrl, endpointServerIdentityId: serverIdentityId, canonicalServerUrl,
    });
    expect(await TokenStorage.setPendingAccountDirectoryAuth({
        ...target, canonicalServerUrl, provider: providerId, mode: 'keyless', proof: 'test-proof',
        credentialTarget: 'account_directory', purpose: 'account_directory', entryIntent, returnTo,
        createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    })).toBe(true);
    const url = 'https://idp.example.test/authorize';
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path.endsWith(`/external/${providerId}/finalize-keyless`)) {
            return Response.json({ error: 'keyed-authentication-required' }, { status: 403 });
        }
        if (path.startsWith(`/v1/auth/external/${providerId}/params?`)) {
            return Response.json({ url, purpose: 'account_directory', credentialTarget: 'account_directory',
                endpointUrl, endpointServerIdentityId: serverIdentityId, canonicalServerUrl,
                expiresAt: new Date(Date.now() + 60_000).toISOString(), desktopAttemptId: 'keyed-attempt',
            });
        }
        return fixture.request(endpoint, path, init);
    });
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(screen?.findByTestId('oauth-browser-wait-title'), screen?.getTextContent()).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url });
    expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toMatchObject({ desktopAttemptId: 'keyed-attempt', mode: 'keyed' });
    await screen.pressByTestIdAsync('oauth-browser-wait-back');
    expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith(returnTo);
});

async function mountTeamEntry() {
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
    const assign = vi.fn();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: { location: { assign } }, configurable: true, writable: true });
    try {
        // Selecting the Team method is the decision. HomeAuthenticationFlow's
        // openChosenAction runs this one-tap method on arrival; its remaining
        // card is a retry, not a second required confirmation.
        await pressEntryCard('team-auth-entry-action:oidc-team');
        await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp.example/authorize'));
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
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    const returnTo = `/teams/team-1/sign-in?target=${encodeURIComponent(fixture.home.homeServerIdentityId)}`;
    await TokenStorage.setPendingExternalConnect({ provider: 'github', returnTo,
        serverId: home.id, serverUrl: home.serverUrl });
    boundary.params.flow = 'connect';
    boundary.params.error = error;
    boundary.params.error_description = 'provider details must stay out of the page';
    boundary.request.mockRejectedValue(new Error('A canceled connect must not finalize'));
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(returnTo));
    if (error === 'access_denied') expect(Modal.alert).not.toHaveBeenCalled();
    else expect(Modal.alert).toHaveBeenCalledWith(t('common.error'), expect.not.stringContaining(boundary.params.error_description));
    expect(await TokenStorage.getPendingExternalConnect()).toBeNull();
    expect(boundary.request).not.toHaveBeenCalled();
});

it('returns canceled fresh Team authentication to its stored Team continuation', async () => {
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

it.each([
    ['an altered', 'returned-admission-reference'],
    ['a missing', undefined],
    ['an empty', ''],
])('rejects a Team callback with %s admission reference for its pending continuation', async (_label, returnedReference) => {
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
    if (returnedReference === undefined) Reflect.deleteProperty(boundary.params, 'admissionReference');
    else boundary.params.admissionReference = returnedReference;
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

    await vi.waitFor(() => expect(screen!.findByTestId('oauth-external-failure')).toBeTruthy());
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(boundary.request).not.toHaveBeenCalled();
    expect(await TokenStorage.getPendingExternalAuth()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('oauth-external-start-again');
    expect(router.replace).toHaveBeenCalledWith(
        `/teams/team-1/sign-in?target=${encodeURIComponent(fixture.home.connectionDescriptor.homeServerIdentityId)}`,
    );
});

it('starts a fresh OAuth request on the same Home only after Start again', async () => {
    const fixture = createDirectoryHttpFixture();
    const home = await adoptHomeProfile({
        descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory',
        descriptorAuthority: 'current_connection_observation',
    });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path.startsWith('/v1/auth/external/oidc-northwind/params?')) {
            return Response.json({ url: 'https://idp.northwind.example/authorize?state=northwind' });
        }
        if (path === '/v1/auth/entry') {
            return Response.json({
                v: 1, state: 'ready', scope: { kind: 'home' },
                autoRedirect: null,
                actions: [{ kind: 'authenticate', methodId: 'oidc-northwind', action: 'login', mode: 'keyless',
                    origin: 'home', presentation: { displayName: 'Northwind Workforce', providerKind: 'oidc' } }],
            } satisfies AuthEntryProjectionV1);
        }
        return fixture.request(endpoint, path, init);
    });
    // Give the focused descriptor-backed Home the normal runtime transport publication.
    await expect(setActiveServerAndSwitch({ serverId: home.id, scope: 'device' })).resolves.toBe('switched');
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
        assign.mockClear();
        boundary.request.mockClear();
        boundary.params.provider = 'oidc-northwind';
        boundary.params.flow = 'auth';
        boundary.params.pending = '';
        boundary.params.error = 'oauth_not_configured';
        boundary.params.error_description = 'private provider diagnostics';
        screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
        await vi.waitFor(() => expect(screen?.findByTestId('oauth-external-failure')).toBeTruthy());
        expect(screen.getTextContent()).not.toContain(boundary.params.error_description);
        expect(assign).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('oauth-external-start-again');
        await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp.northwind.example/authorize?state=northwind'));
        expect(boundary.request.mock.calls.filter(([, path]) => String(path).startsWith('/v1/auth/external/oidc-northwind/params?'))
            .map(([endpoint]) => endpoint)).toEqual([home.serverUrl]);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete (globalThis as { window?: unknown }).window;
    }
});

it.each(['oauth', 'mtls-claim', 'mtls-redirect', 'mtls-web'] as const)('presents a disabled Account on its captured Home after %s proof without committing credentials', async (flow) => {
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
    const reason = t('errors.accountDisabled', { home: homeB.serverUrl });
    if (flow === 'oauth') {
        await vi.waitFor(() => expect(screen?.getTextContent()).toContain(reason));
    } else {
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(t('common.error'), reason));
    }
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
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path === '/v1/auth/external/github/finalize-keyless' || path === '/v1/auth/mtls/claim') {
            expect(endpoint).toBe('https://home-b-transport.test');
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
