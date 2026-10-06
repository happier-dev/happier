import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import {
    adoptHomeProfile,
    adoptPersonalHomeProfileAndComplete,
    getActiveServerId,
    getServerProfileById,
    resolveServerProfileScopeId,
    setAccountServiceEndpoint,
    setActiveServerId,
} from '@/sync/domains/server/serverProfiles';

import { UseServiceAsHomeBody } from './UseServiceAsHomeSheet';

installTokenStorageWebPlatformMocks();

const boundary = vi.hoisted(() => ({ request: vi.fn(), startSystemTask: vi.fn() }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return boundary.request(url.origin, url.pathname, init);
    },
}));
vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => ({ start: boundary.startSystemTask }),
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
let restoreStorage: (() => void) | undefined;
let restoreLocks: (() => void) | undefined;
afterEach(async () => {
    await screen?.unmount();
    restoreLocks?.();
    restoreStorage?.();
    vi.unstubAllGlobals();
});

it('Back before service authentication preserves an offered empty Personal Home while another Home is focused', async () => {
    restoreLocks = installWebLockManagerMock().restore;
    const storage = installLocalStorageMock();
    vi.stubGlobal('sessionStorage', globalThis.localStorage);
    storage.restore();
    restoreStorage = installLocalStorageMock().restore;
    vi.stubGlobal('window', { localStorage: globalThis.localStorage, location: { origin: 'https://app.happier.dev' },
        addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    boundary.request.mockReset();
    boundary.startSystemTask.mockReset();

    const fixture = createDirectoryHttpFixture();
    const personal = await adoptPersonalHomeProfileAndComplete({
        descriptor: fixture.home.connectionDescriptor,
        source: 'desktop-personal-home',
        descriptorAuthority: 'current_connection_observation',
    });
    const other = await adoptHomeProfile({
        descriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_other_home',
            canonicalServerUrl: 'https://other-home.test', endpoints: [{ kind: 'https', url: 'https://other-home.test' }] },
        source: 'account-directory', descriptorAuthority: 'current_connection_observation',
    });
    await TokenStorage.setCredentialsForServerUrl(personal.serverUrl,
        { serverId: resolveServerProfileScopeId(personal) }, { token: fixture.token });
    await setActiveServerId(other.id, { scope: 'device' });
    await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId, source: 'user' });
    const focusAtEntry = getActiveServerId();
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
        if (path === '/v1/home/emptiness/get') return json({ isEmpty: true });
        if (path === '/health') return json({ status: 'ok' });
        if (path === '/v1/auth/ping') return json({ ok: true });
        if (path === '/v1/features') return json(createRootLayoutFeaturesResponse({ capabilities: {
            auth: { keyChallenge: { v2: true }, methods: [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }] },
            accountDirectory: fixture.service.capability,
            serverIdentity: { serverIdentityId: fixture.service.serverIdentityId },
            server: { canonicalServerUrl: fixture.service.endpointUrl },
        } }));
        return fixture.request(endpoint, path, init);
    });
    const onDone = vi.fn();
    screen = await renderScreen(<AuthProvider initialCredentials={null}><UseServiceAsHomeBody onDone={onDone} /></AuthProvider>);

    await vi.waitFor(() => expect(screen?.findByTestId('homes-journeys.remove-empty-personal-home')).not.toBeNull());
    await vi.waitFor(() => expect(screen?.findByTestId('account-service-auth-back')).not.toBeNull());
    await screen.pressByTestIdAsync('account-service-auth-back');

    expect(onDone).toHaveBeenCalledOnce();
    expect(getActiveServerId()).toBe(focusAtEntry);
    expect(getServerProfileById(personal.id)).not.toBeNull();
    expect(await TokenStorage.getCredentialsForServerUrl(personal.serverUrl, { serverId: resolveServerProfileScopeId(personal) })).not.toBeNull();
    expect(boundary.startSystemTask).not.toHaveBeenCalled();
});
