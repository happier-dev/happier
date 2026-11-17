import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import {
  installLocalStorageMock,
  installWebLockManagerMock,
} from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import {
  getServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { LostAccessView } from './LostAccessView';

installTokenStorageWebPlatformMocks();
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module);

await initializeAuthRouteRuntimeForTests();
let localStorage: ReturnType<typeof installLocalStorageMock>;
let locks: ReturnType<typeof installWebLockManagerMock>;
beforeEach(() => {
  localStorage = installLocalStorageMock();
  locks = installWebLockManagerMock();
  resetServerFeaturesClientForTests();
});
afterEach(async () => {
  await standardCleanup();
  resetServerFeaturesClientForTests();
  locks.restore();
  localStorage.restore();
  vi.clearAllMocks();
});

async function renderOnHome(
  providerReset: Readonly<{ enabled: boolean; providers: string[] }>,
) {
  const features = createRootLayoutFeaturesResponse({
    features: {
      auth: { recovery: { providerReset: { enabled: providerReset.enabled } } },
    },
    capabilities: {
      auth: {
        recovery: { providerReset: { providers: providerReset.providers } },
      },
    },
  });
  setRuntimeFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/features') return Response.json(features);
    return new Response('{}', { status: 404 });
  });
  const home = await upsertAndActivateServer({
    serverUrl: 'https://relay.example.test',
    source: 'manual',
    scope: 'device',
  });
  expect(
    (await getServerFeaturesSnapshot({ serverId: home.id, force: true }))
      .status,
  ).toBe('ready');
  const screen = await renderScreen(<LostAccessView returnTo="/restore" />);
  await vi.waitFor(() =>
    expect(screen.findByTestId('lost-access-view')).not.toBeNull(),
  );
  return screen;
}

describe('LostAccessView', () => {
  it('offers the reset on a Home whose provider can reset the account', async () => {
    const screen = await renderOnHome({ enabled: true, providers: ['github'] });

    expect(screen.findByTestId('lost-access-provider-github')).not.toBeNull();
    expect(screen.findByTestId('lost-access-body')?.props.children).toBe('connect.lostAccessBody');
  });

  it('says what is left on a Home that offers no reset instead of promising one', async () => {
    const screen = await renderOnHome({ enabled: false, providers: [] });

    expect(screen.findByTestId('lost-access-body')?.props.children).toBe('connect.lostAccessNoResetBody');
    expect(screen.findAllByTestId('lost-access-provider-github')).toHaveLength(0);
    // The body names the recovery key as a way back, so the step leads there.
    await screen.pressByTestIdAsync('lost-access-use-key');
    expect(navigation.push).toHaveBeenCalledWith('/restore/manual');
  });

  it('keeps a failed capability read distinct from no reset and recovers on retry', async () => {
    const control = await renderOnHome({ enabled: true, providers: ['github'] });
    expect(control.findByTestId('lost-access-provider-github')).not.toBeNull();
    await control.unmount();
    resetServerFeaturesClientForTests();
    setRuntimeFetch(async () => { throw new TypeError('Home is temporarily offline'); });

    const screen = await renderScreen(<LostAccessView returnTo="/restore" />);
    await vi.waitFor(() => expect(screen.findByTestId('lost-access-unavailable')).not.toBeNull());
    expect(screen.findAllByTestId('lost-access-body')).toHaveLength(0);
    expect(screen.findAllByTestId('lost-access-provider-github')).toHaveLength(0);

    const features = createRootLayoutFeaturesResponse({
      features: { auth: { recovery: { providerReset: { enabled: true } } } },
      capabilities: { auth: { recovery: { providerReset: { providers: ['github'] } } } },
    });
    setRuntimeFetch(async () => Response.json(features));
    await screen.pressByTestIdAsync('lost-access-retry');
    await vi.waitFor(() => expect(screen.findByTestId('lost-access-provider-github')).not.toBeNull());
    expect(screen.findByTestId('lost-access-body')?.props.children).toBe('connect.lostAccessBody');
  });
});
