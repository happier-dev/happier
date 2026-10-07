import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { initializeTerminalRouteRuntimeForTests } from '../terminal/terminalRouteTestHelpers';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { adoptHomeProfile, resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

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
await initializeTerminalRouteRuntimeForTests();
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

    it('does not auto-capitalize the case-sensitive Secret Key input', async () => {
        const screen = await renderManualRestoreScreen();
        expect(screen.findByTestId('restore-manual-wizard')).toBeTruthy();
        expect(screen.findByTestId('restore-manual-secret-input')?.props.autoCapitalize).toBe('none');
    });

    it('masks the Secret Key input by default and allows toggling visibility', async () => {
        const screen = await renderManualRestoreScreen();
        const input = screen.findByTestId('restore-manual-secret-input');
        expect(input?.props.secureTextEntry).toBe(true);
        expect(input?.props.multiline).toBe(false);
        await screen.pressByTestIdAsync('restore-manual-secret-reveal');
        expect(screen.findByTestId('restore-manual-secret-input')?.props.secureTextEntry).toBe(false);
    });

    it('persists the restored Secret Key and dismisses to Home without dispatching a nested replace', async () => {
        const token = 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature';
        const secret = encodeBase64(new Uint8Array(32).fill(7), 'base64url');
        const authRequests: RequestInit[] = [];
        const features = createRootLayoutFeaturesResponse({ capabilities: { auth: { keyChallenge: { v2: false } } } });
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(features);
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/auth') {
                authRequests.push(init ?? {});
                return Response.json({ token });
            }
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
        expect(authRequests).toHaveLength(1);
        expect(JSON.parse(String(authRequests[0].body))).toMatchObject({
            publicKey: expect.any(String), challenge: expect.any(String), signature: expect.any(String),
        });
        expect(await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toEqual({ token, secret });
        expect(getActiveServerSnapshot().serverId).toBe(home.id);
        expect(navigation.back).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.dismissTo).toHaveBeenCalledWith('/');
        expect(screen.findByTestId('restore-manual-secret-input')?.props.value).toBe('');
    });
});
