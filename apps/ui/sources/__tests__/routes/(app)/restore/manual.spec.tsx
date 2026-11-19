import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
// Register platform boundaries before the testkit/runtime import graph can load auth storage.
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';

const navigation = vi.hoisted(() => ({
    back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(),
    params: {} as Record<string, string | undefined>,
}));
installTokenStorageWebPlatformMocks();
installRestoreRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => navigation.params,
        router: { back: navigation.back, replace: navigation.replace, dismissTo: navigation.dismissTo },
    }).module,
});
const { renderScreen, standardCleanup } = await import('@/dev/testkit');
const { initializeAuthRouteRuntimeForTests } = await import('@/dev/testkit/harness/authRouteRuntimeHarness');
await initializeAuthRouteRuntimeForTests();
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { isShowcaseHomeLandingPending } = await import('@/onboarding/showcase/storage');
const { adoptHomeProfile, getDeviceDefaultServerId, getTabActiveServerId, resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot, upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const Screen = (await import('@/app/(app)/restore/manual')).default;

let localStorage: ReturnType<typeof installLocalStorageMock>;
beforeEach(() => {
    localStorage = installLocalStorageMock();
    resetServerProfilesRuntimeForTests();
    resetServerFeaturesClientForTests();
    navigation.params = {};
    navigation.back.mockClear();
    navigation.replace.mockClear();
    navigation.dismissTo.mockClear();
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
});
afterEach(async () => {
    await standardCleanup();
    await disconnectActiveServerConnection();
    resetServerFeaturesClientForTests();
    resetServerProfilesRuntimeForTests();
    localStorage.restore();
});

async function renderManualRestoreScreen() {
    return renderScreen(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);
}

describe('/restore/manual', () => {
    it('focuses the restored Home only in its full secondary window', async () => {
        const browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev/desktop/app-window' });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        try {
            const origin = await upsertAndActivateServer({ serverUrl: 'https://main-restore.example.test', scope: 'device' });
            const fixture = createDirectoryHttpFixture();
            const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
                source: 'qr', descriptorAuthority: 'current_connection_observation' });
            navigation.params = { targetServerId: home.id, targetServerUrl: home.serverUrl };
            let pendingAtDismissal = false;
            navigation.dismissTo.mockImplementationOnce(() => { pendingAtDismissal = isShowcaseHomeLandingPending(); });
            const screen = await renderManualRestoreScreen();
            // Authentication itself is covered below; exercise the real post-auth focus handoff.
            await act(async () => { await screen.find(candidate => candidate.props.target?.serverId === home.id)!.props.onAuthenticated(); });
            expect(getActiveServerSnapshot().serverUrl).toBe(home.serverUrl);
            expect(getTabActiveServerId()).toBe(home.id);
            expect(getDeviceDefaultServerId()).toBe(origin.id);
            expect(navigation.dismissTo).toHaveBeenCalledWith('/');
            expect(pendingAtDismissal).toBe(true);
            await screen.unmount();
        } finally {
            vi.unstubAllGlobals();
            browser.restore();
        }
    });

    it('fails closed instead of falling back to the active Home when an exact repair target is incomplete', async () => {
        navigation.params = { returnTo: '/settings/account/api-tokens', resumeCreate: '1', targetServerId: 'home-a' };
        const screen = await renderManualRestoreScreen();
        expect(screen.findByTestId('restore-manual-target-unavailable')).toBeTruthy();
        expect(screen.findByTestId('restore-manual-secret-input')).toBeNull();
    });

    it('binds token-encryption repair to the captured Home address and Account', async () => {
        const fixture = createDirectoryHttpFixture();
        const home = await adoptHomeProfile({
            descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory', descriptorAuthority: 'current_connection_observation',
        });
        navigation.params = {
            returnTo: '/settings/account/api-tokens', resumeCreate: '1',
            targetServerId: home.id, targetServerUrl: home.canonicalServerUrl ?? home.serverUrl,
            expectedAccountId: 'account-a',
        };
        const screen = await renderManualRestoreScreen();
        const exactLogin = screen.find((candidate) => (
            candidate.props.target?.expectedAccountId === 'account-a'
            && candidate.props.target?.serverId === home.id
        ));
        expect(exactLogin?.props.target).toMatchObject({
            endpointUrl: home.serverUrl, canonicalServerUrl: home.canonicalServerUrl ?? home.serverUrl,
            serverId: home.id, serverIdentityId: fixture.home.homeServerIdentityId,
            expectedAccountId: 'account-a', requireKeyChallengeV2: true,
        });
    });

    it('keeps a QR-selected Home target when no Account is known yet', async () => {
        const fixture = createDirectoryHttpFixture();
        const home = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
            source: 'qr', descriptorAuthority: 'current_connection_observation' });
        navigation.params = { targetServerId: home.id, targetServerUrl: home.serverUrl };
        const screen = await renderManualRestoreScreen();
        expect(screen.findByTestId('restore-manual-secret-input')).not.toBeNull();
        expect(screen.find(candidate => candidate.props.target?.serverId === home.id)?.props.target)
            .toMatchObject({ canonicalServerUrl: home.serverUrl });
        navigation.params = { ...navigation.params, returnTo: '/settings/account/api-tokens', resumeCreate: '1' };
        await screen.update(<AuthProvider initialCredentials={null}><Screen /></AuthProvider>);
        expect(screen.findByTestId('restore-manual-target-unavailable')).not.toBeNull();
        expect(screen.findByTestId('restore-manual-secret-input')).toBeNull();
    });

    it('does not auto-capitalize the case-sensitive Secret Key input', async () => {
        const screen = await renderManualRestoreScreen();
        expect(screen.findByTestId('restore-manual-wizard')).toBeTruthy();
        expect(screen.findByTestId('restore-manual-secret-input')?.props.autoCapitalize).toBe('none');
        expect(screen.findByTestId('restore-manual-secret-input')?.props.accessibilityLabel).toBe('connect.secretKeyInputLabel');
    });

    it('is a one-step page: it shows no wizard step counter', async () => {
        // Reached from Settings, token repair and the session view as well as the restore flow, so it
        // has no "Step n of m" of its own to claim.
        const screen = await renderManualRestoreScreen();
        expect(screen.findByTestId('restore-manual-wizard')).toBeTruthy();
        expect(screen.findByTestId('restore-manual-wizard-progress')).toBeNull();
    });

    it('persists the restored Secret Key and dismisses to Home without dispatching a nested replace', async () => {
        let pendingAtDismissal = false;
        navigation.dismissTo.mockImplementationOnce(() => { pendingAtDismissal = isShowcaseHomeLandingPending(); });
        const token = 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature';
        const secret = encodeBase64(new Uint8Array(32).fill(7), 'base64url');
        const authRequests: RequestInit[] = [];
        const features = createRootLayoutFeaturesResponse({ capabilities: { auth: { keyChallenge: { v2: false } } } });
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(features);
            if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
            if (path === '/v1/auth') {
                authRequests.push(init ?? {});
                return Response.json({ token });
            }
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json({
                mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content',
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
            });
            return new Response('{}', { status: 404 });
        });
        const home = await upsertAndActivateServer({ serverUrl: 'https://manual-restore.example.test', scope: 'device' });
        expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
        const screen = await renderManualRestoreScreen();
        await act(async () => { screen.changeTextByTestId('restore-manual-secret-input', '  ' + secret + '  '); });
        await screen.pressByTestIdAsync('restore-manual-submit');
        // The host press starts an async action without returning its promise. Wait for
        // durable browser custody and completion, rather than treating the press as login.
        await act(async () => {
            await vi.waitFor(() => {
                expect([...localStorage.store.values()].includes(JSON.stringify({ token, secret }))).toBe(true);
                expect(navigation.dismissTo).toHaveBeenCalledWith('/');
            });
        });
        expect(authRequests).toHaveLength(1);
        expect(JSON.parse(String(authRequests[0].body))).toMatchObject({
            publicKey: expect.any(String), challenge: expect.any(String), signature: expect.any(String),
        });
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token, secret });
        expect(getActiveServerSnapshot().serverId).toBe(home.id);
        expect(navigation.back).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.dismissTo).toHaveBeenCalledWith('/');
        expect(pendingAtDismissal).toBe(true);
        expect(screen.findByTestId('restore-manual-secret-input')?.props.value).toBe('');
    });
});
