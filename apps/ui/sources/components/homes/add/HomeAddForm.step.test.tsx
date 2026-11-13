import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
installTokenStorageWebPlatformMocks();
// The Home's HTTP answers are the system boundary; the add-home flow, connect owner and sign-in pane are real.
// The module's other transports stay real and reach the platform fetch, which the test points at the same Home.
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/system/runtimeFetch')>()),
    runtimeFetch: network.fetch,
}));

// Collect the real owner graph before the behavior test deadline starts.
await import('./HomeAddForm');

function answerAsHome(url: string) {
  const base = createRootLayoutFeaturesResponse();
  const features = createRootLayoutFeaturesResponse({
    capabilities: {
      server: { canonicalServerUrl: url },
      serverIdentity: { serverIdentityId: 'srv_direct_step' },
      auth: {
        ...base.capabilities.auth,
        methods: [
          {
            id: 'key_challenge',
            actions: [{ id: 'login', enabled: true, mode: 'keyed' }],
          },
        ],
        keyChallenge: { v2: true },
      },
    },
  });
  network.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/health')) return new Response('{}', { status: 200 });
    if (path.endsWith('/v1/features'))
      return new Response(JSON.stringify(features), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return new Response('{}', { status: 404 });
  });
}

describe('Add Home as a step of a host page (the Welcome wizard)', () => {
  afterEach(async () => {
    network.fetch.mockReset();
    vi.unstubAllGlobals();
    const { resetServerProfilesRuntimeForTests } =
      await import('@/sync/domains/server/serverProfiles');
    resetServerProfilesRuntimeForTests();
  });

  it('signs in to a directly connected Home with the host back control as the only way back', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    // The feature probe uses the platform fetch and the reachability probe runtimeFetch: one fake Home answers both.
    vi.stubGlobal('fetch', network.fetch);
    answerAsHome('https://accounts.example.test');
    const backChanges: Array<Readonly<{ onPress?: () => void }> | null> = [];
    const { HomeAddForm } = await import('./HomeAddForm');
    const screen = await renderScreen(
      <AuthProvider initialCredentials={null}>
      <HomeAddForm
        layout="step"
        testID="welcome-connect-home"
        initialPath="direct"
        initialAddress="https://accounts.example.test"
        onClose={() => {}}
        onBackChange={(next) => {
          backChanges.push(next);
        }}
      />
      </AuthProvider>,
    );

    // The direct pane leaves back to its host (the wizard returns to the welcome).
    expect(
      screen.findByTestId('already-use-happier.pane.direct'),
    ).not.toBeNull();
    expect(backChanges.at(-1) ?? null).toBeNull();

    await screen.pressByTestIdAsync('already-use-happier.home-connect');
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('already-use-happier.pane.home-sign-in'),
      ).not.toBeNull(),
    );
    // One way back: the host's control, not a pane link plus a Back card under the methods.
    expect(screen.findByTestId('already-use-happier.another-way')).toBeNull();
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('already-use-happier.home-methods-loading'),
      ).toBeNull(),
    );
    expect(screen.findByTestId('home-auth-back')).toBeNull();
    const back = backChanges.at(-1);
    expect(typeof back?.onPress).toBe('function');

    await act(async () => {
      back!.onPress!();
    });
    expect(
      screen.findByTestId('already-use-happier.pane.direct'),
    ).not.toBeNull();
    expect(backChanges.at(-1) ?? null).toBeNull();
    await screen.unmount();
  });
});
