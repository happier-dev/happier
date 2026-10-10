import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { adoptHomeProfile, upsertServerProfile, resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';
import { HomeRecoveryAuthenticationFlow } from './HomeRecoveryAuthenticationFlow';

installTokenStorageWebPlatformMocks();
installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();

let localStorage: ReturnType<typeof installLocalStorageMock>;
beforeEach(() => {
    localStorage = installLocalStorageMock();
    resetServerProfilesRuntimeForTests();
    resetServerFeaturesClientForTests();
});
afterEach(async () => {
    await standardCleanup();
    resetServerFeaturesClientForTests();
    resetServerProfilesRuntimeForTests();
    localStorage.restore();
});

async function createRecoveryHome() {
    const fixture = createDirectoryHttpFixture();
    const state = { featureReady: true, entryReady: true, requests: [] as URL[] };
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        state.requests.push(url);
        if (url.origin !== fixture.home.canonicalServerUrl) return new Response('{}', { status: 404 });
        // The real explicit-Home request owner admits HTTP through its health probe.
        if (url.pathname === '/health') return Response.json({ status: 'ok' });
        if (url.pathname === '/v1/features' && !state.featureReady) return Response.json({ invalid: true });
        if (url.pathname === '/v1/auth/entry' && !state.entryReady) return Response.json({ v: 999 });
        if (url.pathname === '/v1/features' || url.pathname === '/v1/auth/entry') return fixture.request(url.origin, url.pathname + url.search, init);
        return new Response('{}', { status: 404 });
    });
    await upsertAndActivateServer({ serverUrl: 'https://focused-other.example.test', scope: 'device' });
    const focused = getActiveServerSnapshot();
    const selected = await adoptHomeProfile({
        descriptor: fixture.home.connectionDescriptor, suggestedName: fixture.home.label,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation',
    });
    return { fixture, state, focused, selected };
}

function renderRecovery(profileRef: string) {
    return renderScreen(<InjectedAuthProvider credentials={null}><HomeRecoveryAuthenticationFlow
        profileRef={profileRef} returnTo="/session/session-1"
        onAuthenticated={vi.fn()} onBack={vi.fn()}
    /></InjectedAuthProvider>);
}

describe('HomeRecoveryAuthenticationFlow', () => {
    it('shows the exact saved Home methods even while another Home is focused', async () => {
        const { selected, fixture, state, focused } = await createRecoveryHome();
        const screen = await renderRecovery(selected.id);
        await vi.waitFor(() => expect(screen.findByTestId('home-auth-key_challenge-login-keyed'),
            `${screen.getTextContent()} ${JSON.stringify(state.requests.map(url => url.href))}`).not.toBeNull());
        const flow = screen.findByType(HomeAuthenticationFlow);
        expect(flow.props.target).toEqual({ kind: 'saved_profile', profileRef: selected.id });
        expect(flow.props.actions).toEqual([expect.objectContaining({
            method: expect.objectContaining({ id: 'key_challenge' }),
            action: { id: 'login', mode: 'keyed' },
        })]);
        expect(flow.props.transport).toEqual({ runtimeOrigin: fixture.home.canonicalServerUrl });
        expect(flow.props.returnTo).toBe('/session/session-1');
        expect(flow.props.homeLabel).toBe('Home B');
        expect(state.requests.filter(url => url.pathname === '/v1/auth/entry').map(url => url.origin))
            .toEqual([fixture.home.canonicalServerUrl]);
        expect(getActiveServerSnapshot()).toEqual(focused);
    });

    it('fails closed when the saved Home has no established identity', async () => {
        const selected = await upsertServerProfile({ serverUrl: 'https://identity-missing.example.test', name: 'Unverified Home' });
        const screen = await renderRecovery(selected.id);
        expect(screen.findByTestId('home-recovery-authentication-target-unavailable')).not.toBeNull();
        expect(screen.findAllByType(HomeAuthenticationFlow)).toHaveLength(0);
        expect(screen.findAllByTestId('home-auth-key_challenge-login-keyed')).toHaveLength(0);
    });

    it('names an incompatible Home and retries its actual authentication entry', async () => {
        const { selected, state, focused } = await createRecoveryHome();
        state.entryReady = false;
        const screen = await renderRecovery(selected.id);
        await vi.waitFor(() => expect(screen.findByTestId('home-recovery-authentication-unavailable')).not.toBeNull());
        const card = screen.findByType(SurfaceStateCard);
        expect(card.props.title).toBe('welcome.serverIncompatibleTitle');
        expect(screen.findAllByType(HomeAuthenticationFlow)).toHaveLength(0);
        state.entryReady = true;
        await screen.pressByTestIdAsync('home-recovery-authentication-unavailable-action');
        await vi.waitFor(() => expect(screen.findByTestId('home-auth-key_challenge-login-keyed')).not.toBeNull());
        expect(getActiveServerSnapshot()).toEqual(focused);
    });

    it('re-observes the exact saved Home features on Retry and recovers without borrowing focus', async () => {
        const { selected, fixture, state, focused } = await createRecoveryHome();
        state.featureReady = false;
        expect((await getServerFeaturesSnapshot({ serverId: selected.id, force: true })).status).toBe('unsupported');
        const screen = await renderRecovery(selected.id);
        await vi.waitFor(() => expect(screen.findByTestId('home-recovery-authentication-unavailable')).not.toBeNull());
        expect(screen.findAllByType(HomeAuthenticationFlow)).toHaveLength(0);
        const observedBeforeRetry = state.requests.filter(url => url.origin === fixture.home.canonicalServerUrl && url.pathname === '/v1/features').length;
        state.featureReady = true;
        await screen.pressByTestIdAsync('home-recovery-authentication-unavailable-action');
        await vi.waitFor(() => expect(screen.findByTestId('home-auth-key_challenge-login-keyed')).not.toBeNull());
        expect(state.requests.filter(url => url.origin === fixture.home.canonicalServerUrl && url.pathname === '/v1/features').length)
            .toBeGreaterThan(observedBeforeRetry);
        expect(getActiveServerSnapshot()).toEqual(focused);
    });
});
