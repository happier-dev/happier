import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import { NativeEmailPasswordPreloginResponseV1Schema, NativeEmailPasswordLoginResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { projectAuthEntryMethodCapabilities } from '@/auth/capabilities/authMethodCapabilities';
import { TokenStorage } from '@/auth/storage/tokenStorage';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn(), replace: vi.fn() }));
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { replace: boundary.replace },
}).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

installTokenStorageTestIsolation('home-auth-password', { preserveGenerations: true });
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
await import('@/sync/syncEngine');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { HomeAuthenticationFlow } = await import('./HomeAuthenticationFlow');

let restore: () => void;
let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
beforeEach(() => {
    restore = installLocalStorageMock().restore;
    boundary.request.mockReset();
    boundary.request.mockResolvedValue(new Response('{}', { status: 404 }));
    boundary.replace.mockClear();
    setRuntimeFetch((input, init) => new URL(String(input)).pathname.startsWith('/v1/auth/email/')
        ? boundary.request(String(input), init) : home.request(input, init));
});
afterEach(async () => { await screen?.unmount(); screen = undefined; await disconnectActiveServerConnection(); await home.reset(); restore(); });

it('opens the shared password form from the native auth-entry action without starting OAuth or prelogin', async () => {
    const fixture = createDirectoryHttpFixture();
    const capabilities = projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
        actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either',
            origin: 'home', presentation: { displayName: 'Email and password' } }],
    }));
    screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <HomeAuthenticationFlow
            target={{ kind: 'descriptor', descriptor: fixture.home.connectionDescriptor, authority: 'current_connection' }}
            actions={capabilities.authenticationActions} returnTo="/" onAuthenticated={vi.fn()} onBack={vi.fn()} />
    </AuthProvider>);
    await screen.pressByTestIdAsync('home-auth-email_password-login-either');
    expect(screen.findByTestId('email-password-email')).not.toBeNull();
    expect(screen.findByTestId('email-password-password')?.props.secureTextEntry).toBe(true);
    expect(boundary.request).not.toHaveBeenCalled();
});

it('keeps Back operable while a password submission is still in flight', async () => {
    const fixture = createDirectoryHttpFixture();
    const capabilities = projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
        actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either',
            origin: 'home', presentation: { displayName: 'Email and password' } }],
    }));
    // A real unlock spends seconds in the KDF and the login round trip. The
    // person must be able to leave that wait, so the login never settles here.
    boundary.request.mockImplementation(async (url: string) => {
        if (url.endsWith('/prelogin')) return new Response(JSON.stringify(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' })));
        return await new Promise<Response>(() => {});
    });
    screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <HomeAuthenticationFlow
            target={{ kind: 'descriptor', descriptor: fixture.home.connectionDescriptor, authority: 'current_connection' }}
            actions={capabilities.authenticationActions} returnTo="/" onAuthenticated={vi.fn()} onBack={vi.fn()} />
    </AuthProvider>);
    await screen.pressByTestIdAsync('home-auth-email_password-login-either');
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText('a sufficiently long password');
    });
    await act(async () => {
        screen!.pressByTestId('email-password-submit');
        await Promise.resolve();
    });
    expect(boundary.request.mock.calls.some(([url]) => String(url).endsWith('/v1/auth/email/login'))).toBe(true);

    await act(async () => {
        screen!.pressByTestId('email-password-back');
        await Promise.resolve();
    });

    expect(screen.findByTestId('home-auth-email_password-login-either')).not.toBeNull();
    expect(screen.findByTestId('email-password-password')).toBeNull();
});

it('stores keyless credentials at the captured Home before completing the password journey', async () => {
    const fixture = createDirectoryHttpFixture();
    const credentials = { token: fixture.token };
    const capabilities = projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
        actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either',
            origin: 'home', presentation: { displayName: 'Email and password' } }],
    }));
    const password = '  exact e\u0301 password \ud83d\udd11  ';
    boundary.request.mockImplementation(async (url: string, init: RequestInit) => {
        expect(url.startsWith(fixture.home.canonicalServerUrl)).toBe(true);
        if (url.endsWith('/prelogin')) return new Response(JSON.stringify(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' })));
        expect(url).toBe(`${fixture.home.canonicalServerUrl}/v1/auth/email/login`);
        expect(JSON.parse(String(init.body))).toEqual({ v: 1, email: 'person@example.test', password });
        return new Response(JSON.stringify(NativeEmailPasswordLoginResponseV1Schema.parse(credentials)));
    });
    let completed = false;
    screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <HomeAuthenticationFlow
            target={{ kind: 'descriptor', descriptor: fixture.home.connectionDescriptor, authority: 'current_connection' }}
            actions={capabilities.authenticationActions} returnTo="/" onAuthenticated={async (result) => {
                expect(result).toEqual({ homeServerIdentityId: fixture.home.homeServerIdentityId, credentials });
                expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl,
                    { serverId: fixture.home.homeServerIdentityId })).toEqual(credentials);
                completed = true;
            }} onBack={vi.fn()} />
    </AuthProvider>);
    await screen.pressByTestIdAsync('home-auth-email_password-login-either');
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText(password);
    });
    expect(boundary.request).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('email-password-submit');
    expect(completed).toBe(true);
});

it('keeps a completed Connect login on a retryable arrival when its exact Home cannot be activated', async () => {
    const fixture = createDirectoryHttpFixture();
    const capabilities = projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
        actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'connect', mode: 'either',
            origin: 'home', presentation: { displayName: 'Email and password' } }],
    }));
    boundary.request.mockImplementation(async (url: string) => {
        if (url.endsWith('/prelogin')) return new Response(JSON.stringify(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'plain_password' })));
        return new Response(JSON.stringify({ token: fixture.token }));
    });
    // Activation genuinely fails: the credential is already stored on this Home,
    // but this device could not be moved onto it.
    // No saved profile exists yet, so the exact-Home focus owner genuinely refuses arrival.
    screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <HomeAuthenticationFlow
            target={{ kind: 'descriptor', descriptor: fixture.home.connectionDescriptor, authority: 'current_connection' }}
            actions={capabilities.authenticationActions} returnTo="/" onAuthenticated={vi.fn()} onBack={vi.fn()} />
    </AuthProvider>);
    await screen.pressByTestIdAsync('home-auth-email_password-connect-either');
    await screen.pressByTestIdAsync('email-password-connect-sign-in');
    await act(async () => {
        screen!.findByTestId('email-password-email')!.props.onChangeText('person@example.test');
        screen!.findByTestId('email-password-password')!.props.onChangeText('a sufficiently long password');
    });
    await screen.pressByTestIdAsync('email-password-submit');

    const logins = () => boundary.request.mock.calls
        .filter(([url]) => String(url).endsWith('/v1/auth/email/login')).length;
    expect(logins()).toBe(1);
    // Discarding the opener's answer is what would leave this form mounted over a
    // Home this device is not on, where the only thing left to press re-submits a
    // credential that already committed.
    expect(screen.findByTestId('home-auth-destination-home-error')).not.toBeNull();
    expect(screen.findByTestId('email-password-submit')).toBeNull();

    await home.addHome({ name: 'Authenticated Home', serverUrl: fixture.home.canonicalServerUrl,
        serverIdentityId: fixture.home.homeServerIdentityId, accountId: 'account-home',
        credentials: { token: fixture.token }, active: false });
    await screen.pressByTestIdAsync('home-auth-destination-home-retry');

    await waitForHomeGovernance(() => expect(boundary.replace).toHaveBeenCalledWith({
        pathname: '/settings/account/security', params: { serverId: expect.any(String), intent: 'email_password_connect' },
    }));
    // Retry re-ran only the activation.
    expect(logins()).toBe(1);
    expect(screen.findByTestId('home-auth-destination-home-error')).toBeNull();
});
