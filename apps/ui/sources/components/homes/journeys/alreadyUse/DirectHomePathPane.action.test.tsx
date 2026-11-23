import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { t } from '@/text';

installProviderSettingsRpcBoundary(createProviderSettingsHarness({ machines: [] }));
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { DirectHomePathPane } = await import('./DirectHomePathPane');

afterEach(async () => {
    await standardCleanup();
    await account.reset();
});

it.each([true, false])('checks signed-in Action admission before probing (disabled: %s)', async (disabled) => {
    await account.restore({
        machines: [],
        currentAccount: true,
        settings: { actionsSettingsV1: { v: 1, actions: disabled ? { 'homes.connect': { disabledSurfaces: ['ui'] } } : {} } },
    });
    const address = 'https://another-home.test';
    const probes: string[] = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== address) return account.home.request(input, init);
        probes.push(url.pathname);
        return new Response('{}', { status: 404 });
    });
    const screen = await renderScreen(<DirectHomePathPane initialAddress={address} onHomeConnected={() => {}} onLeave={() => {}} />);
    await vi.waitFor(() => expect(screen.findHostByTestId('already-use-happier.home-connect')?.props.accessibilityState?.disabled).toBe(false));
    await screen.pressByTestIdAsync('already-use-happier.home-connect');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t(disabled ? 'errors.operationFailed' : 'homesJourneys.homeUnreachable')));
    expect(probes).toEqual(disabled ? [] : ['/health']);
});
