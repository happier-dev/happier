import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider } from '@/auth/context/AuthContext';
import { adoptHomeProfile, getActiveServerId, setActiveServerId, resolveServerProfileScopeId, setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { useOnboardingWizardController } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import { useAuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { useAccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import { WizardModalShell } from '@/components/onboarding/ui/WizardModalShell';
import { AuthenticatedAccountEntryRouteSurface } from './AuthenticatedAccountEntryRouteSurface';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return boundary.request(url.origin, url.pathname, init);
    },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restore: (() => void) | undefined;
let unsubscribeFocus: (() => void) | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
afterEach(async () => {
    await screen?.unmount();
    unsubscribeFocus?.();
    webLocks?.restore();
    restore?.();
    screen = undefined;
    unsubscribeFocus = undefined;
    webLocks = undefined;
    restore = undefined;
    vi.unstubAllGlobals();
});

function installStorageGlobals() {
    webLocks = installWebLockManagerMock();
    boundary.request.mockReset();
    const tabStorage = installLocalStorageMock();
    vi.stubGlobal('sessionStorage', globalThis.localStorage);
    tabStorage.restore();
    restore = installLocalStorageMock().restore;
    vi.stubGlobal('window', { localStorage: globalThis.localStorage, location: { origin: 'https://app.happier.dev' },
        addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

/** Answers the probe, challenge and auth legs every exact endpoint needs; the directory fixture owns the rest. */
function answerCommonEndpointRequest(fixture: ReturnType<typeof createDirectoryHttpFixture>, homeAIdentity: Readonly<{ serverUrl: string }>, homeBUrl: string, endpoint: string, path: string): Response | null {
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/v1/auth/ping') return json({ ok: true });
    if (path === '/v2/account/settings') return json({ content: null, version: 0 });
    if (path === '/v1/features') {
        const directory = endpoint === fixture.service.endpointUrl;
        return json({ ...createRootLayoutFeaturesResponse({ capabilities: {
            auth: { keyChallenge: { v2: true }, methods: [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }] },
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
            ...(directory ? { accountDirectory: fixture.service.capability } : {}),
            serverIdentity: { serverIdentityId: directory ? fixture.service.serverIdentityId : endpoint === homeAIdentity.serverUrl ? 'srv_home_a' : fixture.home.homeServerIdentityId },
            server: { canonicalServerUrl: endpoint },
        } }), ...(endpoint === homeBUrl ? { homeConnectionDescriptor: fixture.home.connectionDescriptor } : {}) });
    }
    if (path.endsWith('/challenge')) return json({ challengeId: 'challenge', nonce: 'nonce',
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        audience: { origin: endpoint, serverIdentityId: endpoint === fixture.service.endpointUrl ? fixture.service.serverIdentityId : fixture.home.homeServerIdentityId } });
    if (path === '/v1/auth/account-directory') return json({ token: 'directory-token' });
    return null;
}

async function adoptHomes(fixture: ReturnType<typeof createDirectoryHttpFixture>) {
    const homeA = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_home_a',
        canonicalServerUrl: 'https://home-a.test', endpoints: [{ kind: 'https', url: 'https://home-a.test' }] },
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    const homeB = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(homeA.id, { scope: 'device' });
    await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId, source: 'user' });
    return { homeA, homeB };
}

const submitServiceKey = async () => {
    await act(async () => { screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText('A'.repeat(43)); });
    await screen!.pressByTestIdAsync('restore-manual-submit');
};

it('exits the account-entry route when a key sign-in completion is acknowledged', async () => {
    // Settings › Account › Sign in with a key (intent `refresh`) ends on the
    // `account_connected` card. Its Done belongs to the route host, not to the
    // key form's own Back (which would reopen the sign-in method list).
    installStorageGlobals();
    const fixture = createDirectoryHttpFixture();
    const { homeA, homeB } = await adoptHomes(fixture);
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) =>
        answerCommonEndpointRequest(fixture, homeA, homeB.serverUrl, endpoint, path) ?? fixture.request(endpoint, path, init));
    const onExit = vi.fn();
    screen = await renderScreen(<AuthProvider initialCredentials={null}><AuthenticatedAccountEntryRouteSurface
        request={{ service: fixture.service, intent: { kind: 'refresh' }, returnTo: '/settings/account' }}
        routeParams={{}} onExit={onExit} /></AuthProvider>);
    await vi.waitFor(() => expect(screen?.findByTestId('account-service-auth-key_challenge-login-keyed')).not.toBeNull());
    await screen.pressByTestIdAsync('account-service-auth-key_challenge-login-keyed');
    await submitServiceKey();
    await vi.waitFor(() => expect(screen?.findByTestId('account-service-continuation-account_connected'), screen?.getTextContent()).not.toBeNull());
    // The result card is the route's second step, exactly as on the OAuth return path.
    expect(screen.findByType(WizardModalShell as never).props.stepIndex).toBe(1);

    await screen.pressByTestIdAsync('account-service-continuation-account_connected-action');

    expect(onExit).toHaveBeenCalledWith('/settings/account', { kind: 'account_connected' });
    expect(screen.findByTestId('account-service-auth-key_challenge-login-keyed')).toBeNull();
});

it('reports Back before authentication as an exit without a completion', async () => {
    installStorageGlobals();
    const fixture = createDirectoryHttpFixture();
    const { homeA, homeB } = await adoptHomes(fixture);
    const focusAtEntry = getActiveServerId();
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) =>
        answerCommonEndpointRequest(fixture, homeA, homeB.serverUrl, endpoint, path) ?? fixture.request(endpoint, path, init));
    const onExit = vi.fn();
    screen = await renderScreen(<AuthProvider initialCredentials={null}><AuthenticatedAccountEntryRouteSurface
        request={{ service: fixture.service, intent: { kind: 'enter', target: { kind: 'automatic' } }, returnTo: '/' }}
        routeParams={{}} onExit={onExit} /></AuthProvider>);
    await vi.waitFor(() => expect(screen?.findByTestId('account-service-auth-key_challenge-login-keyed')).not.toBeNull());

    await act(async () => screen!.findByType(WizardModalShell as never).props.onBack());

    expect(onExit).toHaveBeenCalledExactlyOnceWith('/');
    expect(getActiveServerId()).toBe(focusAtEntry);
});

it.each(['route', 'wizard', 'cancel'])('%s retains service-key continuation until exact Home authentication and material are ready', async (surface) => {
    installStorageGlobals();
    const fixture = createDirectoryHttpFixture();
    if (surface !== 'wizard') {
        fixture.state.homes = [];
        fixture.state.preferredHomeServerIdentityId = null;
    } else {
        fixture.state.approval = 'approved';
        fixture.state.mode = 'e2ee';
    }
    const { homeA, homeB } = await adoptHomes(fixture);
    const originalFocus = getActiveServerId();
    const prematureFocus: string[] = [];
    unsubscribeFocus = subscribeActiveServer((snapshot) => { if (snapshot.serverId !== originalFocus) prematureFocus.push(snapshot.serverId); });
    let releaseHomeAuthentication: (() => void) | undefined;
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        const common = answerCommonEndpointRequest(fixture, homeA, homeB.serverUrl, endpoint, path);
        if (common) return common;
        if (path === '/v1/auth') {
            expect(endpoint).toBe(homeB.serverUrl);
            expect(getActiveServerId()).toBe(originalFocus);
            if (surface === 'cancel') await new Promise<void>((resolve) => { releaseHomeAuthentication = resolve; });
            return json({ token: fixture.token });
        }
        return fixture.request(endpoint, path, init);
    });
    const onExit = vi.fn();
    const onPostAuth = vi.fn();
    function WizardBody() {
        const authEntryOptions = useAuthEntryOptions();
        const accountServiceEntry = useAccountServiceEntryOptions();
        const controller = useOnboardingWizardController({ layout: 'portrait', isDesktopShell: false,
            authEntryOptions, accountServiceEntry,
            accountContinuationIntent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: fixture.home.homeServerIdentityId } },
            onAccountDirectoryKeyResult: (result) => { onPostAuth(result); if (result.kind === 'home_entered') onExit('/'); },
        });
        return <>{controller.body}</>;
    }
    screen = await renderScreen(<AuthProvider initialCredentials={null}>{surface === 'wizard' ? <WizardBody /> : <AuthenticatedAccountEntryRouteSurface
        request={{ service: fixture.service, intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: fixture.home.homeServerIdentityId } }, returnTo: '/' }}
        routeParams={{}} onExit={onExit} />}</AuthProvider>);
    const serviceKeyAction = surface === 'wizard' ? 'welcome-account-service-key' : 'account-service-auth-key_challenge-login-keyed';
    await vi.waitFor(() => expect(screen?.findByTestId(serviceKeyAction)).not.toBeNull());
    await screen.pressByTestIdAsync(serviceKeyAction);
    const submitKey = submitServiceKey;
    await submitKey();
    expect(prematureFocus).toEqual([]);
    expect(getActiveServerId()).toBe(originalFocus);
    if (surface === 'wizard') {
        expect(onPostAuth, JSON.stringify(boundary.request.mock.calls.map(([endpoint, path]) => ({ endpoint, path })))).toHaveBeenCalledWith(expect.objectContaining({ kind: 'home_material_required' }));
        expect(screen.findByTestId('restore-manual-secret-input')).not.toBeNull();
        expect(getActiveServerSnapshot().serverId).toBe(originalFocus);
    }
    if (surface !== 'wizard') {
        // The unlinked Home's card leads with signing in to that exact Home.
        await vi.waitFor(() => expect(screen?.findByTestId('account-service-continuation-explicit_target_not_linked-action')).not.toBeNull());
        await screen.pressByTestIdAsync('account-service-continuation-explicit_target_not_linked-action');
        await vi.waitFor(() => expect(screen?.findByTestId('home-auth-key_challenge-login-keyed'), screen?.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('home-auth-key_challenge-login-keyed');
    }
    if (surface === 'cancel') {
        await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: `${fixture.token}-before-cancel` });
        const credentialsBeforeCancellation = await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: fixture.home.homeServerIdentityId });
        const authenticating = submitKey();
        await vi.waitFor(() => expect(releaseHomeAuthentication).toBeTypeOf('function'));
        await screen.pressByTestIdAsync('authenticated-account-entry-wizard-back');
        const authenticationSignal = boundary.request.mock.calls.find(([, path]) => path === '/v1/auth')?.[2]?.signal;
        const requestAbortedOnBack = authenticationSignal?.aborted;
        await act(async () => { releaseHomeAuthentication!(); await authenticating; });
        expect(requestAbortedOnBack).toBe(true);
        expect(onExit).toHaveBeenCalledExactlyOnceWith('/');
        expect(getActiveServerSnapshot().serverId).toBe(originalFocus);
        expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual(credentialsBeforeCancellation);
        return;
    }
    await submitKey();
    expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual(
        surface === 'route' ? { token: fixture.token } : { token: fixture.token, secret: 'A'.repeat(43) });
    await vi.waitFor(() => expect(onExit, `${screen?.getTextContent()} ${JSON.stringify(boundary.request.mock.calls.map(([endpoint, path]) => ({ endpoint, path })))}`).toHaveBeenCalledWith(
        '/', ...(surface === 'wizard' ? [] : [{ kind: 'home_entered', homeServerIdentityId: fixture.home.homeServerIdentityId, selection: 'explicit' }]),
    ));
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(homeB));
    expect(fixture.state.calls.filter(({ path }) => path.includes('/login-assertion'))).toHaveLength(surface === 'route' ? 0 : 1);
});
