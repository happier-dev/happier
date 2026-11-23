import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { t } from '@/text';

const routes = createExpoRouterMock();
vi.mock('expo-router', () => routes.module);
installProviderSettingsRpcBoundary(createProviderSettingsHarness({ machines: [] }));
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { getActiveServerId, listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
const { HomeAddDraftScreen } = await import('@/components/homes/add/HomeAddDraftScreen');

const address = 'https://another-home.test';

afterEach(async () => {
    await standardCleanup();
    await account.reset();
    routes.resetParams();
});

async function mountDraft(disabled: boolean) {
    await account.restore({
        machines: [],
        currentAccount: true,
        settings: { actionsSettingsV1: { v: 1, actions: disabled ? { 'homes.connect': { disabledSurfaces: ['ui'] } } : {} } },
    });
    routes.state.router.setParams({ address, path: 'direct' });
    const probes: string[] = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== address) return account.home.request(input, init);
        probes.push(url.pathname);
        return Response.json(url.pathname === '/health' ? { status: 'ok' } : createSignInServiceFeaturesResponse(address), {
            status: url.pathname === '/health' || url.pathname === '/v1/features' ? 200 : 404,
        });
    });
    const activeHome = getActiveServerId();
    const screen = await renderScreen(<HomeAddDraftScreen />);
    return { activeHome, probes, screen };
}

function savedHomes() {
    return listServerProfiles().filter((profile) => profile.serverUrl === address);
}

it.each([true, false])('applies the signed-in Account policy when Connect is pressed (disabled: %s)', async (disabled) => {
    const { activeHome, probes, screen } = await mountDraft(disabled);
    await vi.waitFor(() => expect(screen.findHostByTestId('already-use-happier.home-connect')?.props.accessibilityState?.disabled).toBe(false));
    expect(screen.findByTestId('already-use-happier.home-address')?.props.value).toBe(address);
    expect(savedHomes()).toHaveLength(0);
    expect(probes).toEqual([]);
    await screen.pressByTestIdAsync('already-use-happier.home-connect');
    if (disabled) {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.operationFailed')));
        expect(probes).toEqual([]);
        expect(savedHomes()).toHaveLength(0);
    } else {
        await vi.waitFor(() => expect(savedHomes()).toHaveLength(1));
    }
    expect(getActiveServerId()).toBe(activeHome);
});
