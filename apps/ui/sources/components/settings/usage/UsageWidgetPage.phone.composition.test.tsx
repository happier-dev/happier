import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// The window's measured size and the device's pointer are the boundaries; the phone classification stays real.
const viewport = vi.hoisted(() => ({
  width: 390,
  height: 844,
  scale: 1,
  fontScale: 1,
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
  }),
);
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    pathname: '/settings/usage',
    segments: () => ['(app)', 'settings', 'usage'],
    params: () => ({}),
  }).module;
});
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const { invalidateUsageQueryResources } =
  await import('@/sync/api/account/usageQueryResource');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { MainAppTabStateProvider } =
  await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { AppPaneProvider } =
  await import('@/components/appShell/panes/AppPaneProvider');
const { CurrentUiContextProvider } =
  await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { WidgetAreaLayoutBar } =
  await import('@/components/widgets/area/WidgetAreaLayoutBar');
const { UsageFilterBar } = await import('./UsageFilterBar');
const { UsageWidgetPage } = await import('./UsageWidgetPage');

const totals: UsageAnalyticsQueryResponse['totals'] = {
  eventCount: 1,
  tokens: {
    input: 10,
    output: 5,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 15,
  },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
};
const accounting: UsageAnalyticsQueryResponse = {
  v: 1,
  totals,
  breakdowns: {},
};
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;

beforeEach(() => {
  Object.assign(viewport, { width: 390, height: 844 });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone)',
    maxTouchPoints: 1,
  });
});

afterEach(async () => {
  standardCleanup();
  vi.unstubAllGlobals();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
});

async function renderUsagePage() {
  home = await serveActionHomes({
    homes: [
      {
        key: 'a',
        serverUrl: 'https://usage-phone.test',
        accountId: 'account-a',
      },
    ],
    route: (request) =>
      request.path === '/v1/features' ||
      request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : request.path === '/v1/kv/bulk'
          ? Response.json({ values: [] })
          : request.path === '/v2/usage/query'
            ? Response.json(accounting)
            : (createEmptyAccountBootstrapHttpResponse(request.path, {
                method: request.method,
              }) ?? undefined),
  });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({
    serverId: server.id,
    serverUrl: server.serverUrl,
    generation: 0,
  });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(
    server.serverUrl,
  ))!;
  return renderScreen(
    <InjectedAuthProvider credentials={credentials}>
      <MainAppTabStateProvider>
        <AppPaneProvider>
          <CurrentUiContextProvider>
            <UsageWidgetPage
              initialFilters={{
                layoutId: 'overview',
                period: '7days',
                metric: 'tokens',
                costMode: 'auto',
                focus: null,
              }}
            />
          </CurrentUiContextProvider>
        </AppPaneProvider>
      </MainAppTabStateProvider>
    </InjectedAuthProvider>,
  );
}

// D23: arranging dashboards is desktop work, but choosing a view is not arranging one. A phone keeps the
// view chooser without its + and ⋯ (create, rename, reorder); a wide window keeps both.
it('keeps the view chooser on a phone without the arranging controls', async () => {
  const phone = await renderUsagePage();
  await waitForHomeGovernance(() =>
    expect(phone.findAllByType(UsageFilterBar)).toHaveLength(1),
  );
  const [phoneBar] = phone.findAllByType(WidgetAreaLayoutBar);
  expect(phoneBar?.props.layouts.length).toBeGreaterThan(1);
  expect(phoneBar?.props.onCreate).toBeNull();
  expect(phoneBar?.props.actions).toBeNull();
  await phone.unmount();
  await home?.dispose();
  home = undefined;
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();

  Object.assign(viewport, { width: 1440, height: 900 });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh)',
    maxTouchPoints: 0,
  });
  const wide = await renderUsagePage();
  await waitForHomeGovernance(() =>
    expect(wide.findAllByType(WidgetAreaLayoutBar)).toHaveLength(1),
  );
  expect(wide.findAllByType(WidgetAreaLayoutBar)[0]?.props.onCreate).toBeTypeOf('function');
});
