import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { renderScreen } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage, digestAccountDirectoryCredentialToken } from '@/auth/storage/tokenStorage';
import { AuthProvider } from '@/auth/context/AuthContext';
import { adoptHomeProfile, getActiveServerId, setActiveServerId, setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { completeAccountServicePostAuth } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { AccountServiceSettingsSection } from './AccountServiceSettingsSection';
import { HomeDeviceApprovalSection } from '../server/sections/HomeDeviceApprovalSection';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/settings/account' }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restore: (() => void) | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreExecutor: (() => void) | undefined;
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { CurrentUiContextProvider, useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
let currentReader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
function CurrentReaderProbe() {
    currentReader = useOptionalCurrentUiContextReader();
    return null;
}
afterEach(async () => {
    await screen?.unmount(); screen = undefined;
    await cancelPendingDirectoryHomeEnrollment();
    await connection?.dispose(); connection = undefined;
    restoreExecutor?.(); restoreExecutor = undefined;
    resetRuntimeFetch(); restore?.();
    currentReader = null;
});

it.each(['account', 'approval'])('%s Settings resumes exact Home authentication without another enrollment or focus', async (surface) => {
    boundary.request.mockClear();
    restore = installLocalStorageMock().restore;
    const fixture = createDirectoryHttpFixture();
    const homeA = await adoptHomeProfile({ descriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_home_a',
        canonicalServerUrl: 'https://home-a.test', endpoints: [{ kind: 'https', url: 'https://home-a.test' }] },
        source: 'account-directory', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(homeA.id, { scope: 'device' });
    const activeHomeA = getActiveServerId();
    const credentialsA = { token: createAccountTokenForTests('account-a') };
    await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: 'srv_home_a' }, credentialsA);
    await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId, source: 'user' });
    await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: fixture.service.endpointUrl,
        serverIdentityId: fixture.service.serverIdentityId }, { token: fixture.directoryToken });
    let linkMissing = false;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path === '/health') return json({ status: 'ok' });
        if (path === '/v1/auth/ping') return json({});
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v1/kv/bulk') return json({ values: [] });
        if ((path === '/v1/features' || path === '/v1/features/authenticated') && endpoint === homeA.serverUrl) return json(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_home_a' }, server: { canonicalServerUrl: endpoint },
        } }));
        // This Home has no optional bootstrap catalogs; report unsupported HTTP routes, not transport failures.
        if (endpoint === homeA.serverUrl) return json({}, 404);
        if (path.includes('/login-assertion') && linkMissing) return json({ error: 'directory_link_not_found' }, 404);
        if (path === '/v1/features' && endpoint === fixture.home.canonicalServerUrl) return json({
            ...createRootLayoutFeaturesResponse({ capabilities: { auth: { keyChallenge: { v2: true },
                methods: [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }] },
                serverIdentity: { serverIdentityId: fixture.home.homeServerIdentityId }, server: { canonicalServerUrl: endpoint } } }),
            homeConnectionDescriptor: fixture.home.connectionDescriptor,
        });
        if (path === '/v1/auth/challenge') return json({ challengeId: 'challenge-b', nonce: 'nonce',
            issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
            audience: { origin: fixture.home.canonicalServerUrl, serverIdentityId: fixture.home.homeServerIdentityId } });
        if (path === '/v1/auth') { expect(endpoint).toBe(fixture.home.canonicalServerUrl); return json({ token: fixture.token }); }
        return fixture.request(endpoint, path, init);
    });
    restoreExecutor = await installRealActionExecutorModuleLoader();
    connection = await restoreServerAccountForTest({ serverUrl: homeA.serverUrl,
        serverIdentityId: 'srv_home_a', credentials: credentialsA, credentialScope: 'restored-home',
        request: async (input, init) => {
            const url = new URL(String(input));
            return boundary.request(url.origin, url.pathname, init);
        } });
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        return boundary.request(url.origin, url.pathname, init);
    });
    await completeAccountServicePostAuth({ service: fixture.service,
        credentialTokenDigest: await digestAccountDirectoryCredentialToken(fixture.directoryToken),
        session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
        intent: { kind: 'enroll', homeServerIdentityId: fixture.home.homeServerIdentityId } });
    screen = await renderScreen(<AuthProvider initialCredentials={credentialsA}>
        <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><CurrentUiContextActionHost /><CurrentReaderProbe />
            <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>{surface === 'account'
                ? <AccountServiceSettingsSection /> : <HomeDeviceApprovalSection homes={[]} />}
            </PluginSurfaceFocusEligibilityProvider>
        </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
    </AuthProvider>);
    fixture.state.approval = 'expired';
    if (surface === 'approval') await screen.pressByTestIdAsync('settings.server.homeEnrollment.pending.retry');
    await vi.waitFor(() => expect(getPendingDirectoryHomeEnrollment()).toBeNull(), { timeout: 3000 });
    // The mounted host publishes the real Account command after restoration finishes.
    await vi.waitFor(async () => {
        await act(async () => {});
        expect(currentReader?.readCurrentUiContext()?.commands.some(({ id }) => {
            const command = currentReader?.resolveCurrentUiCommand(id)?.command;
            return command?.kind === 'accountHomeContinuation' && command.operation === 'refresh';
        })).toBe(true);
    });
    linkMissing = true;
    await screen.pressByTestIdAsync('account-service-continuation-failure-action');
    // The Home-auth recovery card leads with signing in to that exact Home as its own primary action.
    await vi.waitFor(() => expect(screen?.findAll((node) => node.props.testID === 'account-service-continuation-failure-action'
        && typeof node.props.title === 'string' && node.props.title.startsWith('Sign in to')),
        `${screen?.getTextContent()} ${JSON.stringify(boundary.request.mock.calls.map(([endpoint, path]) => ({ endpoint, path })))}`).not.toHaveLength(0));
    await screen.pressByTestIdAsync('account-service-continuation-failure-action');
    await vi.waitFor(() => expect(screen?.findByTestId('home-auth-key_challenge-login-keyed'),
        `${screen?.getTextContent()} ${JSON.stringify(boundary.request.mock.calls.map(([endpoint, path]) => ({ endpoint, path })))}`).not.toBeNull());
    await screen.pressByTestIdAsync('home-auth-key_challenge-login-keyed');
    const requestsBeforeAuth = boundary.request.mock.calls.filter(([, path]) => path.includes('/login-assertion')).length;
    await act(async () => { screen!.findByTestId('restore-manual-secret-input')!.props.onChangeText('A'.repeat(43)); });
    await screen.pressByTestIdAsync('restore-manual-submit');
    await vi.waitFor(async () => expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl,
        { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token, secret: 'A'.repeat(43), custody: 'historical' }));
    expect(screen.findByTestId('restore-manual-secret-input')).toBeNull();
    expect(getActiveServerId()).toBe(activeHomeA);
    expect(boundary.request.mock.calls.filter(([, path]) => path.includes('/login-assertion'))).toHaveLength(requestsBeforeAuth);
});
