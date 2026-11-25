// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import {
  configureConnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

// P03 cut 45: a cold signed-in load of `/` on a Home served over plain http://localhost
// stayed blank. The saved descriptor declares the Home's HTTP(S) origin and an Iroh
// endpoint this browser cannot use. Automatic policy verifies the declared origin first,
// with a bearer readiness probe to exactly that candidate, before it publishes it; the
// authenticated bootstrap must then start over the selected origin.
installTokenStorageWebPlatformMocks();
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: {
      get: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
    },
    useWindowDimensions: () => ({
      width: 1440,
      height: 900,
      scale: 1,
      fontScale: 1,
    }),
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('expo-router', async () => ({
  ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
  usePathname: () => '/',
  useSegments: () => ['(app)'],
  useLocalSearchParams: () => ({}),
}));
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: () => {
      throw new Error('Markdown is outside cold launch');
    },
  }),
);

await initializeRealAppRuntimeForTests();

async function expectColdDescriptorHomeBootstrap(serverUrl: string) {
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const { finishLaunchCurtain } = await import('@/boot/launchCurtain');
  const { AuthProvider } = await import('@/auth/context/AuthContext');
  const { AppShellPluginUiProjectionProvider } =
    await import('../plugins/AppShellPluginUiProjection');
  const { WorkspaceAppShellProvider } =
    await import('./WorkspaceAppShellProvider');
  const { storage } = await import('@/sync/domains/state/storage');
  const { profileDefaults } = await import('@/sync/domains/profiles/profile');

  // One Home identity per address: a second address claiming the same identity is a conflict.
  const serverIdentityId = `srv_descriptor_${new URL(serverUrl).protocol.replace(':', '')}`;
  const accountId = `cold-descriptor-${new URL(serverUrl).protocol.replace(':', '')}`;
  const credentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.sig`,
    secret: Buffer.alloc(32, 7).toString('base64url'),
    custody: 'historical' as const,
  };
  const descriptor = {
    v: 1 as const,
    homeServerIdentityId: serverIdentityId,
    canonicalServerUrl: serverUrl,
    revision: 1,
    endpoints: [
      { kind: 'https' as const, url: serverUrl },
      { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
    ],
  };
  const authenticated = new Map<string, number>();
  const bearerOrigins = new Set<string>();
  const features = createRootLayoutFeaturesResponse();
  const featuresResponse = {
    ...features,
    capabilities: {
      ...features.capabilities,
      serverIdentity: { serverIdentityId },
    },
    homeConnectionDescriptor: descriptor,
  };

  // A signed-in device already saved this Home's descriptor; the cold load reads it before any request.
  const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
  const { setServerProfileIdentityForUrl, reconcileServerProfileHomeConnectionDescriptor } = await import(
    '@/sync/domains/server/serverProfiles'
  );
  await upsertServerProfileOnly({ serverUrl, name: 'Test Home' });
  await setServerProfileIdentityForUrl(serverUrl, serverIdentityId);
  const seeded = await reconcileServerProfileHomeConnectionDescriptor({
    serverUrl,
    observedServerIdentityId: serverIdentityId,
    descriptor,
    observation: 'exact',
  });
  expect(seeded.kind).not.toBe('conflict');

  const screen = await renderScreen(<></>);
  const restore = await restoreServerAccountForTest({
    serverUrl,
    serverIdentityId,
    accountId,
    credentials,
    retainFailedColdRestore: true,
    requestOwnsReachabilityProbes: true,
    configureSocket: configureConnectedServerSocketBoundary,
    request: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (new Headers(init?.headers).has('authorization')) {
        authenticated.set(path, (authenticated.get(path) ?? 0) + 1);
        bearerOrigins.add(new URL(String(input)).origin);
      }
      if (path === '/v1/auth/ping') return Response.json({ ok: true });
      if (path === '/health') return Response.json({});
      if (path === '/v1/account/encryption')
        return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v1/account/encryption/currentness')
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/features' || path === '/v1/features/authenticated')
        return Response.json(featuresResponse);
      if (path === '/v2/account/settings')
        return Response.json({ content: null, version: 0 });
      if (path === '/v1/account/profile')
        return Response.json({ ...profileDefaults, id: accountId });
      return createEmptyAccountBootstrapHttpResponse(path, init);
    },
  });
  try {
    await screen.update(
      <AuthProvider initialCredentials={credentials}>
        <AppShellPluginUiProjectionProvider>
          <WorkspaceAppShellProvider>
            <></>
          </WorkspaceAppShellProvider>
        </AppShellPluginUiProjectionProvider>
      </AuthProvider>,
    );
    await vi.waitFor(
      () => {
        expect(authenticated.get('/v2/account/settings')).toBeGreaterThan(0);
      },
      { timeout: 12000 },
    );
    expect(restore.home.homeConnectionDescriptor?.endpoints).toEqual(
      descriptor.endpoints,
    );
    expect(storage.getState().isDataReady).toBe(true);
    // The bearer reached only the origin the carrier policy selected.
    expect([...bearerOrigins]).toEqual([new URL(serverUrl).origin]);
  } finally {
    console.log(
      'COLD_DESCRIPTOR_BOOTSTRAP',
      JSON.stringify({
        serverUrl,
        authorized: Object.fromEntries(authenticated),
        descriptor: Boolean(restore.home.homeConnectionDescriptor),
      }),
    );
    await screen.unmount();
    finishLaunchCurtain();
    await restore.dispose();
    vi.unstubAllGlobals();
  }
}

describe('cold signed-in restore of a saved descriptor Home whose Iroh endpoint is unusable', () => {
  it(
    'starts the authenticated bootstrap over a plain HTTP loopback Home',
    () => expectColdDescriptorHomeBootstrap('http://localhost:3018'),
    25000,
  );
  it(
    'starts the authenticated bootstrap over an HTTPS-origin Home',
    () => expectColdDescriptorHomeBootstrap('https://home.example.test'),
    25000,
  );
});
