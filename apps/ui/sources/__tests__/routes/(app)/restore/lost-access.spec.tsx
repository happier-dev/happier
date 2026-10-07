import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createWelcomeFeaturesResponse } from '../index.testHelpers';
import { initializeTerminalRouteRuntimeForTests } from '../terminal/terminalRouteTestHelpers';
import { installRestoreRouteCommonModuleMocks } from './restoreRouteTestHelpers';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';

const native = vi.hoisted(() => ({
    secureValues: new Map<string, string>(),
    canOpenURL: vi.fn(async () => true),
    openURL: vi.fn(async () => true),
}));
installTokenStorageWebPlatformMocks({
    // Genuine native credential persistence adapter; TokenStorage parsing and custody stay real.
    secureStore: () => ({
        getItemAsync: async (key: string) => native.secureValues.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => { native.secureValues.set(key, value); },
        deleteItemAsync: async (key: string) => { native.secureValues.delete(key); },
    }),
});
installRestoreRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios', select: <T,>(spec: { ios?: T; default?: T }) => spec.ios ?? spec.default },
        Linking: { canOpenURL: native.canOpenURL, openURL: native.openURL },
    }),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module,
});
await initializeTerminalRouteRuntimeForTests();
const Screen = (await import('@/app/(app)/restore/lost-access')).default;

let localStorage: ReturnType<typeof installLocalStorageMock>;
beforeEach(() => {
    localStorage = installLocalStorageMock();
    native.secureValues.clear();
    native.openURL.mockClear();
    native.canOpenURL.mockClear();
    resetServerFeaturesClientForTests();
});
afterEach(async () => {
    await standardCleanup();
    resetServerFeaturesClientForTests();
    localStorage.restore();
});

const features = createWelcomeFeaturesResponse({
    signupMethods: [{ id: 'anonymous', enabled: false }, { id: 'github', enabled: true }],
    requiredProviders: ['github'], autoRedirectEnabled: false, autoRedirectProviderId: null,
    recoveryProviderResetEnabled: true, recoveryProviderResetProviders: ['github'],
});

async function renderLostAccess(externalUrl: string) {
    const oauthRequests: Array<{ url: URL; init?: RequestInit }> = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/features') return Response.json(features);
        if (url.pathname === '/v1/auth/external/github/params') {
            oauthRequests.push({ url, init });
            return Response.json({ url: externalUrl });
        }
        return new Response('{}', { status: 404 });
    });
    const home = await upsertAndActivateServer({ serverUrl: 'https://lost-access.example.test', scope: 'device' });
    expect((await getServerFeaturesSnapshot({ serverId: home.id, force: true })).status).toBe('ready');
    const capturedHome = getActiveServerSnapshot();
    const screen = await renderScreen(<Screen />);
    await vi.waitFor(() => expect(screen.findByTestId('lost-access-provider-github')).not.toBeNull());
    return { screen, oauthRequests, capturedHome };
}

describe('/restore/lost-access', () => {
    it('retains reset intent and exact Home custody before opening the provider signup URL', async () => {
        const { screen, oauthRequests, capturedHome } = await renderLostAccess('https://example.test/oauth');
        expect(screen.findByTestId('restore-lost-access-wizard')).toBeTruthy();
        await screen.pressByTestIdAsync('lost-access-provider-github');

        const pending = await TokenStorage.getPendingExternalAuth();
        expect(pending).toMatchObject({
            provider: 'github', intent: 'reset',
            serverId: capturedHome.serverId, serverUrl: capturedHome.serverUrl,
        });
        expect(pending?.secret).toEqual(expect.any(String));
        const encodedSecret = pending?.secret;
        if (typeof encodedSecret !== 'string') throw new Error('Expected retained reset secret');
        const secret = decodeBase64(encodedSecret, 'base64url');
        expect(secret).toHaveLength(32);
        const publicKey = encodeBase64(sodium.crypto_sign_seed_keypair(secret).publicKey);
        expect(oauthRequests).toHaveLength(1);
        expect(oauthRequests[0].url.origin).toBe(capturedHome.serverUrl);
        expect(oauthRequests[0].url.searchParams.get('publicKey')).toBe(publicKey);
        expect(new Headers(oauthRequests[0].init?.headers).has('Authorization')).toBe(false);
        expect(native.canOpenURL).toHaveBeenCalledWith('https://example.test/oauth');
        expect(native.openURL).toHaveBeenCalledWith('https://example.test/oauth');
        expect(getActiveServerSnapshot()).toEqual(capturedHome);
    });

    it('rejects an unsafe provider URL without OS navigation and removes the attempted custody', async () => {
        const { screen, capturedHome } = await renderLostAccess('javascript:alert(1)');
        await screen.pressByTestIdAsync('lost-access-provider-github');

        expect(native.canOpenURL).not.toHaveBeenCalled();
        expect(native.openURL).not.toHaveBeenCalled();
        expect(await TokenStorage.getPendingExternalAuth()).toBeNull();
        expect(getActiveServerSnapshot()).toEqual(capturedHome);
    });
});
