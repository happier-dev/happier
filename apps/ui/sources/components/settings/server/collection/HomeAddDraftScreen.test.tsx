import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

const withoutSyntheticTimestamps = (items: readonly ServerProfile[]) => items.map(({ createdAt, updatedAt, ...profile }) => profile);

const routes = createExpoRouterMock();
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
installTokenStorageWebPlatformMocks();
vi.mock('expo-router', () => routes.module);
// HTTP, authentication, modal UI and locale are environment boundaries. The
// draft, form, connect operation, readiness probe and profile persistence stay real.
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, refreshFromActiveServer: async () => {} }),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Collect the real UI graph before the behavior deadline; route/native boundaries stay unchanged.
await import('@/components/homes/add/HomeAddDraftScreen');

beforeEach(async () => {
    routes.resetParams();
    routes.state.router.setParams({ path: 'direct' });
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `home-address-draft-${crypto.randomUUID()}`);
    network.fetch.mockImplementation(async () => new Response('{}', { status: 404 }));
    (await import('@/utils/system/runtimeFetch')).setRuntimeFetch(network.fetch);
    (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
});
afterEach(() => {
    standardCleanup();
    network.fetch.mockReset();
    vi.unstubAllEnvs();
});

async function renderDraft() {
    const { HomeAddDraftScreen } = await import('@/components/homes/add/HomeAddDraftScreen');
    return renderScreen(<HomeAddDraftScreen />);
}

describe('Home address draft', () => {
    it.each(['explicit', 'automatic'] as const)('handles a %s Directory-capable Home address without selecting it as a service', async (entry) => {
        const address = 'https://accounts.example.test';
        routes.state.router.setParams({ address, path: entry === 'explicit' ? 'other_service' : 'direct', auto: entry === 'automatic' ? '1' : undefined });
        network.fetch.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            return new Response(JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : createSignInServiceFeaturesResponse(address)), {
                status: url.endsWith('/health') || url.endsWith('/v1/features') ? 200 : 404,
                headers: { 'content-type': 'application/json' },
            });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const beforeService = profiles.resolveSelectedAccountServiceEndpoint();
        const beforeProfiles = profiles.listServerProfiles();
        const beforeFocus = profiles.getActiveServerId();
        const screen = await renderDraft();
        if (entry === 'explicit') {
            await vi.waitFor(() => expect(screen.findByTestId('already-use-happier.service-address')?.props.value).toBe(address));
            expect(screen.findByTestId('already-use-happier.pane.direct')).toBeFalsy();
            expect(withoutSyntheticTimestamps(profiles.listServerProfiles())).toEqual(withoutSyntheticTimestamps(beforeProfiles));
            expect(profiles.getActiveServerId()).toBe(beforeFocus);
        } else {
            await vi.waitFor(() => expect(profiles.listServerProfiles().some((profile) => profile.serverUrl === address)).toBe(true));
        }
        expect(screen.findByTestId('settings.homes.draft.autoFailed')).toBeFalsy();
        expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(beforeService);
    });

    it('associates Home link and address fields with persistent labels', async () => {
        const screen = await renderDraft();
        expect(screen.findByTestId('already-use-happier.home-link')?.props).toMatchObject({
            accessibilityLabelledBy: 'already-use-happier-home-link-label',
        });
        expect(screen.findByTestId('already-use-happier.home-address')?.props).toMatchObject({
            accessibilityLabelledBy: 'already-use-happier-home-address-label',
        });
    });

    it('exposes pending connection and announces failed address validation without saving a Home', async () => {
        const health = createDeferred<Response>();
        network.fetch.mockImplementation(async (url: RequestInfo | URL) => String(url) === 'https://unavailable.example.test/health'
            ? health.promise : new Response('{}', { status: 404 }));
        const screen = await renderDraft();
        const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
        const before = listServerProfiles();
        await vi.waitFor(() => expect(screen.findHostByTestId('already-use-happier.home-connect')?.props.accessibilityState?.disabled).toBe(false));
        await act(async () => screen.changeTextByTestId('already-use-happier.home-address', 'https://unavailable.example.test'));
        await screen.pressByTestIdAsync('already-use-happier.home-connect');
        const pending = screen.findAllByProps({ testID: 'already-use-happier.home-connect' })
            .find((node) => typeof node.type === 'string');
        expect(pending?.props.accessibilityState?.busy ?? pending?.props['aria-busy']).toBe(true);
        await act(async () => health.resolve(new Response('{}', { status: 404 })));
        await vi.waitFor(() => expect(screen.findByTestId('already-use-happier.home-address-error')?.props).toMatchObject({
            accessibilityRole: 'alert',
            accessibilityLiveRegion: 'polite',
        }));
        expect(withoutSyntheticTimestamps(listServerProfiles())).toEqual(withoutSyntheticTimestamps(before));
    });
});
