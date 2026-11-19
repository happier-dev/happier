import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
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
const { SurfaceFreshnessLine } =
  await import('@/components/ui/surfaces/SurfaceFreshnessLine');
const { t } = await import('@/text');

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
const visibleContentGeometry = {
  measureInWindow: (
    done: (x: number, y: number, width: number, height: number) => void,
  ) => done(0, 0, viewport.width, 300),
};

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let readFails = false;

beforeEach(() => {
  Object.assign(viewport, { width: 390, height: 844 });
  readFails = false;
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
  vi.restoreAllMocks();
});

async function renderUsagePage(layoutId = 'overview', response = accounting) {
  const artifacts = createArtifactStoreBoundary({
    ownerAccountId: () => 'account-a',
    encryptionMode: 'plain',
  });
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
          : request.path === '/v2/usage/query-batch'
            ? undefined
          : request.path === '/v2/usage/query'
            ? readFails
              ? Response.json({ error: 'unavailable' }, { status: 503 })
              : Response.json(response)
            : (artifacts.handle(request.url.toString(), {
                method: request.method,
              }) ?? createEmptyAccountBootstrapHttpResponse(request.path, {
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
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={credentials}>
      <MainAppTabStateProvider>
        <AppPaneProvider>
          <CurrentUiContextProvider>
            <UsageWidgetPage
              initialFilters={{
                layoutId,
                period: '7days',
                metric: layoutId === 'costs' ? 'cost' : 'tokens',
                costMode: 'auto',
                focus: null,
              }}
            />
          </CurrentUiContextProvider>
        </AppPaneProvider>
      </MainAppTabStateProvider>
    </InjectedAuthProvider>,
    {
      createNodeMock: (node) =>
        node.props.testID === 'usage-page'
          ? { getInnerViewRef: () => visibleContentGeometry }
          : visibleContentGeometry,
    },
  );
  await act(async () => {
    screen.findByTestId('usage-page')!.props.onLayout?.({
      nativeEvent: {
        layout: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      },
    });
  });
  return screen;
}

// D23 (owner 11-09): the dashboard chooser and its + leave the phone; it shows the selected view under its
// filters. A wide window keeps them.
it('leaves the dashboard chooser off a phone and keeps it on a wide window', async () => {
  const phone = await renderUsagePage();
  await waitForHomeGovernance(() =>
    expect(phone.findAllByType(UsageFilterBar)).toHaveLength(1),
  );
  expect(phone.findAllByType(WidgetAreaLayoutBar)).toHaveLength(0);
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

// USAGE-ACCEPT 1118 #9: a phone's one header line cannot hold the read-failure sentence. Like the partial
// form, it says the short word with Details and keeps its one Retry; Details opens the whole sentence.
it('gives the phone read-failure notice the short form with Details and its Retry', async () => {
  readFails = true;
  const phone = await renderUsagePage('costs');
  const line = () => phone.findAllByType(SurfaceFreshnessLine)
    .find(candidate => candidate.props.testID === 'usage-page.header.failed');
  await waitForHomeGovernance(() => expect(line(), JSON.stringify(phone.findAllByType(SurfaceFreshnessLine)
    .map(candidate => [candidate.props.testID, candidate.props.reason]))).toBeDefined());
  expect(line()!.props.reason).toBe(t('usage.board.charts.coveragePartialShort'));
  const actions = line()!.props.actions as readonly { testID?: string; onPress: () => void }[];
  expect(actions.map(action => action.testID)).toEqual(['usage-page.header.failed.detail', 'usage-page.header.retry']);
  await act(async () => { actions[0]!.onPress(); });
  expect(line()!.props.reason).not.toBe(t('usage.board.charts.coveragePartialShort'));
  expect((line()!.props.actions as readonly { testID?: string }[]).map(action => action.testID))
    .toEqual(['usage-page.header.failed.detail', 'usage-page.header.retry']);
});

it('dates the header by the read and shows the older source date in Details', async () => {
  const readAt = Date.UTC(2026, 10, 19, 12);
  const sourceAt = Date.UTC(2026, 9, 10, 2, 6);
  vi.spyOn(Date, 'now').mockReturnValue(readAt);
  const { formatUsageObservedAt } = await import('@/sync/domains/usage/usageCalendarPresentation');
  const { usageSourceTitle } = await import('@/sync/domains/usage/usageLabels');
  const phone = await renderUsagePage('costs', {
    ...accounting,
    coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
      range: { startMs: Date.UTC(2026, 10, 12), endMs: readAt, complete: false },
      sources: [
        { source: 'claude-sdk-result', path: 'runtime', status: 'partial', eventCount: 1, asOfMs: sourceAt, historyComplete: false },
        { source: 'runtime', path: 'runtime', status: 'available', eventCount: 1, asOfMs: readAt - 1, historyComplete: true },
      ] },
  });
  const line = () => phone.findAllByType(SurfaceFreshnessLine)
    .find(candidate => candidate.props.testID?.startsWith('usage-page.header.') && candidate.props.asOf != null);
  await waitForHomeGovernance(() => expect(line()?.props.asOf).toBe(readAt));
  const actions = line()!.props.actions as readonly { label: string; onPress: () => void }[];
  expect(line()!.props.reason).not.toContain(formatUsageObservedAt(sourceAt));
  const details = actions.find(action => action.label === t('common.details'));
  expect(details).toBeDefined();
  await act(async () => { details!.onPress(); });
  expect(line()!.props.asOf).toBe(readAt);
  expect(line()!.props.reason).toContain(usageSourceTitle('claude-sdk-result', undefined, 'coverage'));
  expect(line()!.props.reason).toContain(formatUsageObservedAt(sourceAt));
});
