import { parseAuthenticatedAccountEntryRoute } from './authenticatedAccountEntryRoute';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import type { EmailPasswordLoginTarget } from '@/auth/password/loginEmailPassword';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessHttpResponse } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { Platform } from 'react-native';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { installTokenStorageTestIsolation } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { encodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider, setCurrentAuth } from '@/auth/context/AuthContext';
import { adoptHomeProfile, getActiveServerId, setActiveServerId, resolveServerProfileScopeId, setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { stopAllEndpointSupervisorsForTests } from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { useOnboardingWizardController } from '@/components/onboarding/surfaces/useOnboardingWizardController';
import { useAuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { useAccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import { WizardModalShell } from '@/components/onboarding/ui/WizardModalShell';
import { AuthenticatedAccountEntryRouteSurface } from './AuthenticatedAccountEntryRouteSurface';
import { HomeRecoveryAuthenticationFlow } from '@/components/account/auth/HomeRecoveryAuthenticationFlow';
import TeamSignInRoute from '@/app/(app)/teams/[teamId]/sign-in';
import { SecretKeyLoginForm, type SecretKeyLoginTarget } from '@/components/account/restore/SecretKeyLoginForm';
import { EmailPasswordAuthPanel } from '@/components/account/auth/emailPassword/EmailPasswordAuthPanel';
import { AccountServiceAuthenticationFlow } from '@/components/account/auth/AccountServiceAuthenticationFlow';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

// The connection singleton spans this file; reset fixture storage without
// moving its owning Home generation lifetime backwards between cases.
installTokenStorageTestIsolation('n4_a2_account_journey', { preserveGenerations: true });
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
const navigation = vi.hoisted(() => ({ push: vi.fn(), params: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    return { ...mock.module, useLocalSearchParams: () => navigation.params, router: { ...mock.module.router, push: navigation.push } };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/utils/web/reactDomCjs', async () =>
    (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

await loadSyncSingletonForTests();

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let unsubscribeFocus: (() => void) | undefined;
afterEach(async () => {
    await screen?.unmount();
    await disconnectActiveServerConnection();
    await stopAllEndpointSupervisorsForTests();
    setCurrentAuth(null);
    resetRuntimeFetch();
    unsubscribeFocus?.();
    browser?.restore();
    screen = undefined;
    unsubscribeFocus = undefined;
    browser = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function installStorageGlobals() {
    boundary.request.mockReset().mockImplementation(async () => new Response('{}', { status: 404 }));
    navigation.push.mockReset();
    navigation.params = {};
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
    setRuntimeFetch((input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return boundary.request(url.origin, url.pathname, init);
    });
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

it('shows the managed Account-service affordance for a foreign desktop deep link before contacting it', async () => {
    await installStorageGlobals();
    vi.stubGlobal('isTauri', true);
    Object.assign(window, { __HAPPIER_WEB_RUNTIME_CONFIG__: {
        organizationPolicyJson: JSON.stringify({ schemaVersion: 1, organization: 'Example',
            accountService: { url: 'https://managed.example.test', locked: true } }),
    } });
    const link = new URL('happier://homes/sign-in');
    link.searchParams.set('accountServiceEndpoint', 'https://foreign.example.test');
    link.searchParams.set('accountServiceIdentity', 'srv_foreign');
    link.searchParams.set('accountIntent', JSON.stringify({ kind: 'refresh' }));
    link.searchParams.set('accountEntryReturnTo', '/settings/account');
    const href = resolveNativeAppLinkHref(link.href);
    expect(href).not.toBeNull();
    const params = Object.fromEntries(new URL(href!, 'https://app.example.test').searchParams);
    const request = parseAuthenticatedAccountEntryRoute(params);
    expect(request).not.toBeNull();
    screen = await renderScreen(<AuthenticatedAccountEntryRouteSurface request={request!} routeParams={params} onExit={() => {}} />);
    await vi.waitFor(() => expect(screen?.findByTestId('organization-policy-accountService'), screen?.getTextContent()).not.toBeNull());
    expect(screen.findByTestId('account-service-auth-key_challenge-login-keyed')).toBeNull();
    expect(boundary.request.mock.calls.filter(([endpoint]) => endpoint === 'https://foreign.example.test')).toEqual([]);
});

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

it.each([...( ['directory', 'home'] as const).flatMap(journey => (['success', 'cancel', 'failure'] as const).map(outcome => ({ journey, outcome }))), ...(['team', 'direct_key', 'password', 'oauth'] as const).map(journey => ({ journey, outcome: 'cancel' as const }))])('moves a secondary Account switch to main with its source Home before acquisition ($journey, $outcome)', async ({ journey, outcome }) => {
    await installStorageGlobals();
    const fixture = createDirectoryHttpFixture();
    const { homeA, homeB } = await adoptHomes(fixture);
    const directoryJourney = journey === 'directory' || journey === 'oauth';
    const previousToken = `hdr.${Buffer.from(JSON.stringify({ sub: 'outgoing-account' })).toString('base64')}.sig`;
    const incomingToken = directoryJourney
        ? `hdr.${Buffer.from(JSON.stringify({ sub: fixture.state.me.accountId })).toString('base64')}.sig`
        : fixture.token;
    const values = new Map<string, string>();
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    const listeners = new Map<string, Map<number, (event: { payload: unknown }) => void>>();
    let nextId = 0;
    const order: string[] = [];
    let persistenceAtTeardown: unknown;
    const primaryWindow = browser!.window;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'desktop_secure_storage_read') return values.get(String(args?.key)) ?? null;
        if (command === 'desktop_secure_storage_write') { values.set(String(args?.key), String(args?.value)); return; }
        if (command === 'desktop_secure_storage_remove') { values.delete(String(args?.key)); return; }
        if (command === 'plugin:event|listen') {
            const event = String(args?.event);
            const entries = listeners.get(event) ?? new Map();
            const id = ++nextId;
            entries.set(id, callbacks.get(Number(args?.handler))!);
            listeners.set(event, entries);
            return id;
        }
        if (command === 'plugin:event|unlisten') { listeners.get(String(args?.event))?.delete(Number(args?.eventId)); return; }
        if (command === 'desktop_show_main_window') { order.push('main-focused'); return; }
        if (command === 'desktop_app_windows_teardown') {
            expect(args).toEqual({ scopes: [{ serverId: resolveServerProfileScopeId(homeB), accountId: 'outgoing-account' }] });
            // Observe the native storage boundary without re-entering the
            // Home writer's mutation authority through a TokenStorage getter.
            const persisted = [...values.values()].some(raw => raw.includes(incomingToken));
            persistenceAtTeardown = {
                platform: Platform.OS, embed: isEmbedWindowContext(), storageKeys: Object.keys(primaryWindow.localStorage),
                nativeKeys: [...values.keys()], nativeCommands: invoke.mock.calls.map(([name]) => name),
            };
            expect(persisted, JSON.stringify(persistenceAtTeardown)).toBe(true);
            order.push('outgoing-closed');
            return;
        }
        if (command === 'desktop_window_emit_action') {
            expect(JSON.stringify(args?.payload)).not.toContain(previousToken);
            expect(JSON.stringify(args?.payload)).not.toContain(incomingToken);
            vi.stubGlobal('window', primaryWindow);
            internals.metadata.currentWindow.label = 'main';
            await setActiveServerId(homeA.id);
            for (const callback of listeners.get('desktopWindow://action')?.values() ?? []) callback({ payload: args?.payload });
        }
        if (command === 'desktop_window_emit_action_result') {
            for (const callback of listeners.get('desktopWindow://action-result')?.values() ?? []) callback({ payload: args?.payload });
        }
    });
    const internals = { invoke, metadata: { currentWindow: { label: 'main' } },
        transformCallback: (callback: (event: { payload: unknown }) => void) => { const id = ++nextId; callbacks.set(id, callback); return id; } };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    Object.assign(primaryWindow, { __TAURI_INTERNALS__: internals, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
    if (directoryJourney) expect(await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { token: previousToken })).toBe(true);
    else expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, { token: previousToken })).toBe(true);
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        const currentness = createPlainAccountEncryptionCurrentnessHttpResponse(path);
        if (currentness) return currentness;
        if (path === '/v1/auth/entry') return new Response('{}', { status: 404 });
        if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: new Headers(init?.headers).get('authorization') === `Bearer ${previousToken}`
            ? 'outgoing-account' : directoryJourney ? fixture.state.me.accountId : 'account-home' }));
        if (path === (directoryJourney ? '/v1/auth/account-directory' : '/v1/auth')) {
            expect(order).toEqual(['main-focused']);
            expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(homeB));
            order.push('acquired-in-main');
            return outcome === 'failure' ? new Response('{}', { status: 503 }) : json({ token: incomingToken });
        }
        if (journey === 'home' && path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        return answerCommonEndpointRequest(fixture, homeA, homeB.serverUrl, endpoint, path) ?? fixture.request(endpoint, path, init);
    });
    const primary = await renderScreen(<AuthProvider initialCredentials={null}><></></AuthProvider>);
    let secondary: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await vi.waitFor(() => expect(listeners.get('desktopWindow://action')?.size).toBe(1));
        await setActiveServerId(homeB.id);
        internals.metadata.currentWindow.label = 'destination_auth_journey';
        vi.stubGlobal('window', { location: { href: 'tauri://localhost/desktop/window?id=auth_journey' }, __TAURI_INTERNALS__: internals,
            __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
        navigation.params = { teamId: 'team-auth-entry', serverId: homeB.id };
        const target = { endpointUrl: homeB.serverUrl, canonicalServerUrl: homeB.serverUrl, addressAnchorUrl: homeB.serverUrl, serverId: homeB.id,
            serverIdentityId: homeB.serverIdentityId!, requireKeyChallengeV2: true } satisfies EmailPasswordLoginTarget & SecretKeyLoginTarget;
        secondary = await renderScreen(journey === 'directory'
            ? <AuthenticatedAccountEntryRouteSurface request={{ service: fixture.service, intent: { kind: 'refresh' }, returnTo: '/settings/account' }} routeParams={{}} onExit={() => {}} />
            : <AuthProvider initialCredentials={null}>{journey === 'team' ? <TeamSignInRoute />
                : journey === 'direct_key' ? <SecretKeyLoginForm target={target} returnTo="/settings/account" onAuthenticated={() => {}} />
                : journey === 'password' ? <EmailPasswordAuthPanel target={target} recoveryTarget={homeB.id} action="login" mode="either" returnTo="/settings/account" onAuthenticated={() => {}} />
                : journey === 'oauth' ? <AccountServiceAuthenticationFlow service={{ authority: fixture.service, displayName: 'Directory', authenticationActions: [{
                    method: { id: 'github', enabledActions: [{ id: 'login', mode: 'keyless' }] }, action: { id: 'login', mode: 'keyless' }, execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
                }] }} intent={{ kind: 'refresh' }} returnTo="/setup/wizard" accountEntryReturnTo="/settings/account" onResult={() => {}} onPostAuthContinuation={() => {}} onExternalAuthStarted={() => {}} onBack={() => {}} />
                : <HomeRecoveryAuthenticationFlow profileRef={homeB.id} returnTo="/settings/account" onAuthenticated={() => {}} onBack={() => {}} />}</AuthProvider>);
        if (journey === 'oauth') await secondary.pressByTestIdAsync('account-service-auth-github-login-keyless');
        await vi.waitFor(() => expect(navigation.push, secondary?.getTextContent()).toHaveBeenCalledOnce());
        expect(secondary.findByTestId('restore-manual-secret-input')).toBeNull();
        expect(boundary.request.mock.calls.filter(([, path]) => path.includes('/auth/account-directory'))).toEqual([]);
        expect(order).toEqual(['main-focused']);
        expect(directoryJourney
            ? await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })
            : await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual({ token: previousToken });
        if (journey === 'team') {
            expect(navigation.push.mock.calls[0]![0]).toBe(`/teams/team-auth-entry/sign-in?serverId=${encodeURIComponent(homeB.id)}`);
            expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(homeB));
            return;
        }
        const href = navigation.push.mock.calls[0]![0] as { params: Record<string, string> };
        expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(homeB));
        if (directoryJourney) {
            const request = parseAuthenticatedAccountEntryRoute(href.params);
            expect(request).not.toBeNull();
            screen = await renderScreen(<AuthProvider initialCredentials={null}><AuthenticatedAccountEntryRouteSurface request={request!} routeParams={href.params} onExit={() => {}} /></AuthProvider>);
        } else {
            expect(href.params).toMatchObject({ recoveryProfile: homeB.id, recoveryReturnTo: '/settings/account' });
            screen = await renderScreen(<AuthProvider initialCredentials={null}><HomeRecoveryAuthenticationFlow profileRef={href.params.recoveryProfile!} returnTo={href.params.recoveryReturnTo!} onAuthenticated={() => {}} onBack={() => {}} /></AuthProvider>);
        }
        const keyAction = directoryJourney ? 'account-service-auth-key_challenge-login-keyed' : 'home-auth-key_challenge-login-keyed';
        await vi.waitFor(() => expect(screen!.findByTestId(keyAction)).not.toBeNull());
        if (outcome === 'cancel') {
            if (directoryJourney) await screen.pressByTestIdAsync('authenticated-account-entry-wizard-back');
            else await screen.pressByTestIdAsync('home-auth-back');
            expect(order).toEqual(['main-focused']);
        } else {
            await screen.pressByTestIdAsync(keyAction);
            await submitServiceKey();
            if (outcome === 'success') await vi.waitFor(() => expect(order, JSON.stringify({ surface: screen?.getTextContent(), persistenceAtTeardown })).toEqual(
                directoryJourney ? ['main-focused', 'acquired-in-main'] : ['main-focused', 'acquired-in-main', 'outgoing-closed']));
            else expect(order).toEqual(['main-focused', 'acquired-in-main']);
        }
        if (outcome === 'success') await vi.waitFor(async () => expect(directoryJourney
            ? await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })
            : await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toMatchObject({ token: incomingToken }));
        if (outcome !== 'success') expect(directoryJourney
            ? await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })
            : await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual({ token: previousToken });
    } finally {
        vi.stubGlobal('window', primaryWindow);
        await secondary?.unmount();
        await primary.unmount();
        await screen?.unmount();
        screen = undefined;
        const nativeWindow = primaryWindow as unknown as Record<string, unknown>;
        delete nativeWindow.__TAURI_INTERNALS__;
        delete nativeWindow.__TAURI_EVENT_PLUGIN_INTERNALS__;
    }
});

it('exits the account-entry route when a key sign-in completion is acknowledged', async () => {
    // Settings › Account › Sign in with a key (intent `refresh`) ends on the
    // `account_connected` card. Its Done belongs to the route host, not to the
    // key form's own Back (which would reopen the sign-in method list).
    await installStorageGlobals();
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
    await installStorageGlobals();
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
    await installStorageGlobals();
    const materialCompletion = vi.spyOn(await import('@/sync/ops/accountDirectory/completeAccountServicePostAuth'), 'supplyAccountServiceHomeMaterial');
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
        await vi.waitFor(() => expect(onPostAuth, JSON.stringify(boundary.request.mock.calls.map(([endpoint, path]) => ({ endpoint, path })))).toHaveBeenCalledWith(expect.objectContaining({ kind: 'home_material_required' })));
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
    if (surface === 'wizard') {
        await act(async () => screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText(encodeBase64(fixture.homeRecoverySecret, 'base64url')));
        await screen.pressByTestIdAsync('restore-manual-submit');
        expect(materialCompletion).toHaveBeenCalledOnce();
        const completion = materialCompletion.mock.results[0];
        if (completion?.type !== 'return') throw new Error('Expected material completion to return its real operation');
        await act(async () => { await completion.value; });
    } else {
        await submitKey();
    }
    await vi.waitFor(async () => expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual({
        token: fixture.token,
        ...(surface === 'wizard' ? { secret: encodeBase64(fixture.homeRecoverySecret, 'base64url') } : {}),
    }));
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith('/', ...(surface === 'wizard' ? [] : [{
        kind: 'home_entered', homeServerIdentityId: fixture.home.homeServerIdentityId, selection: 'explicit',
    }])));
    expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(homeB));
    expect(fixture.state.calls.filter(({ path }) => path.includes('/login-assertion'))).toHaveLength(surface === 'route' ? 0 : 1);
});
