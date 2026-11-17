import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { adoptHomeProfile, resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import type { AccountPostAuthInput } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { AccountServiceHomeAuthenticationAdapter } from './AccountServiceHomeAuthenticationAdapter';
import { HomeAuthenticationFlow } from './HomeAuthenticationFlow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

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

type EntryAnswer = 'ready' | 'unsupported' | 'incompatible' | 'unavailable' | 'update_required';

// The saved Home publishes a released feature catalog (github) that differs from its
// contextual auth-entry projection (key), so the test can tell which one won.
async function createSavedHome(entry: EntryAnswer) {
    const fixture = createDirectoryHttpFixture();
    const requests: URL[] = [];
    setRuntimeFetch(async (request, init) => {
        const url = new URL(String(request));
        requests.push(url);
        if (url.origin !== fixture.home.canonicalServerUrl) return new Response('{}', { status: 404 });
        if (url.pathname === '/health') return Response.json({ status: 'ok' });
        if (url.pathname === '/v1/features') return Response.json({
            ...createRootLayoutFeaturesResponse({ capabilities: {
                serverIdentity: { serverIdentityId: fixture.home.homeServerIdentityId },
                auth: { methods: [{ id: 'github', actions: [{ id: 'login', enabled: true, mode: 'keyless' }] }] },
            } }),
            homeConnectionDescriptor: fixture.home.connectionDescriptor,
        });
        if (url.pathname === '/v1/auth/entry') {
            if (entry === 'ready') return fixture.request(url.origin, url.pathname + url.search, init);
            if (entry === 'unsupported') return new Response('{}', { status: 404 });
            if (entry === 'incompatible') return Response.json({ v: 999 });
            if (entry === 'update_required') return Response.json({
                v: 1, state: 'update_required', scope: { kind: 'home' },
                reason: 'client_update_required', autoRedirect: null,
            });
            return new Response('{}', { status: 503 });
        }
        return new Response('{}', { status: 404 });
    });
    await adoptHomeProfile({
        descriptor: fixture.home.connectionDescriptor, suggestedName: fixture.home.label,
        source: 'account-directory', descriptorAuthority: 'current_connection_observation',
    });
    const input: AccountPostAuthInput = {
        service: fixture.service,
        session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId },
            { capability: fixture.service.capability }),
        credentialTokenDigest: 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM',
        intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: fixture.home.homeServerIdentityId } },
    };
    return { fixture, requests, input };
}

function renderAdapter(input: AccountPostAuthInput, homeServerIdentityId: string) {
    return renderScreen(<InjectedAuthProvider credentials={null}><AccountServiceHomeAuthenticationAdapter
        input={input}
        previous={{ kind: 'explicit_target_not_linked', homeServerIdentityId }}
        homeServerIdentityId={homeServerIdentityId}
        returnTo="/settings/account"
        onResult={vi.fn()}
        onBack={vi.fn()}
    /></InjectedAuthProvider>);
}

describe('AccountServiceHomeAuthenticationAdapter', () => {
    it('uses the exact Home auth-entry projection instead of the legacy feature catalog', async () => {
        const { fixture, requests, input } = await createSavedHome('ready');
        const screen = await renderAdapter(input, fixture.home.homeServerIdentityId);

        await vi.waitFor(() => expect(screen.findAllByType(HomeAuthenticationFlow), screen.getTextContent()).toHaveLength(1));
        const flow = screen.findByType(HomeAuthenticationFlow);
        expect(flow.props.actions).toEqual([
            expect.objectContaining({
                method: expect.objectContaining({ id: 'key_challenge' }),
                action: { id: 'login', mode: 'keyed' },
                execution: { kind: 'key_entry' },
            }),
        ]);
        expect(flow.props.transport).toEqual({ runtimeOrigin: fixture.home.canonicalServerUrl });
        expect(requests.filter(url => url.pathname === '/v1/auth/entry').map(url => url.origin))
            .toEqual([fixture.home.canonicalServerUrl]);
        expect(flow.props.accountContinuation).toMatchObject({
            credentialTokenDigest: input.credentialTokenDigest,
            homeServerIdentityId: fixture.home.homeServerIdentityId,
        });
    });

    it('uses the released feature projection only when the contextual endpoint is explicitly unsupported', async () => {
        const { fixture, input } = await createSavedHome('unsupported');
        const screen = await renderAdapter(input, fixture.home.homeServerIdentityId);

        await vi.waitFor(() => expect(screen.findAllByType(HomeAuthenticationFlow), screen.getTextContent()).toHaveLength(1));
        expect(screen.findByType(HomeAuthenticationFlow).props.actions).toEqual([
            expect.objectContaining({
                method: expect.objectContaining({ id: 'github' }),
                action: { id: 'login', mode: 'keyless' },
                execution: { kind: 'oauth', providerId: 'github', mode: 'keyless' },
            }),
        ]);
    });

    it.each(['incompatible', 'unavailable', 'update_required'] as const)(
        'fails closed when the contextual endpoint is %s',
        async (kind) => {
            const { fixture, input } = await createSavedHome(kind);
            const screen = await renderAdapter(input, fixture.home.homeServerIdentityId);

            await vi.waitFor(() => expect(screen.findByTestId('account-service-home-auth-unavailable')).not.toBeNull());
            expect(screen.findAllByType(HomeAuthenticationFlow)).toHaveLength(0);
            expect(screen.findByType(SurfaceStateCard).props.title).toBe(t('common.error'));
            expect(screen.getTextContent()).toContain(t('errors.operationFailed'));
            expect(screen.getTextContent()).not.toContain(t('welcome.serverUnavailableTitle'));
            expect(screen.getTextContent()).not.toContain(t('welcome.signInServiceUnavailableTitle'));
        },
    );
});
