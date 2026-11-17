import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createTelemetryCollectorActionBoundary } from '@/dev/testkit/harness/telemetryCollectorActionBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { usageAppCallsSourceId } from '@/sync/domains/usage/usageAppCallsSource';
import { UsageWidgetPage } from './UsageWidgetPage';
import { UsageFilterBar } from './UsageFilterBar';
import { UsageCostFactsWidget } from './widgets/UsageCostFactsWidget';
import {
  buildUsageRouteParams,
  resolveUsagePageInitialFilters,
} from './usageRouteParams';
import {
  USAGE_SOURCES_SHOW_AGENTS,
  USAGE_SOURCES_SHOW_APPS,
  type UsageWidgetPageFilter,
} from './useUsageWidgetPageFilters';

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
// The collector daemon's own RPC is an external boundary; Action admission and dispatch stay real.
const daemonRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));

const agentTotals: UsageAnalyticsQueryResponse['totals'] = {
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
const agentAccounting: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: agentTotals,
  breakdowns: {
    source: [{ key: 'native', ...agentTotals }],
    agent: [{ key: 'claude', ...agentTotals }],
  },
};
const catalog: UsageModelPriceCatalog = {
  v: 1,
  models: {
    'gpt-5-mini': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 4,
      cacheReadUsdPerMillion: 1,
      cacheWriteUsdPerMillion: 3,
    },
  },
  provenance: {
    source: 'litellm',
    origin: 'fetched',
    asOfMs: 1000,
    revision: 'catalog-nov-14',
    fetchStatus: 'ready',
  },
};
const tokens = {
  input: 1_000_000,
  output: 1_000_000,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 2_000_000,
};
const operand = (modelId: string, callCount: number) => ({
  bucketStartMs: 1_000,
  provider: 'vendor',
  modelId,
  requestedModel: modelId,
  operation: 'chat',
  callCount,
  tokens,
  tokenCategories: tokens,
  reportedCost: null,
  firstSeenMs: 1_000,
  lastSeenMs: 2_000,
});

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let withdrawProjection: (() => void) | undefined;
afterEach(async () => {
  withdrawProjection?.(); withdrawProjection = undefined;
  vi.restoreAllMocks();
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
});

// The page's own controls run its published commands through the mounted current-context port, as in the app shell.
function CurrentContextPort() {
  const reader = useOptionalCurrentUiContextReader();
  React.useEffect(() => {
    if (!reader) return;
    return registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
      reader, invocationSurface: surface, hostAction, readProjection: () => null, readNavigationBinding: () => null,
    }));
  }, [reader]);
  return null;
}

// The route is the page's display-choice owner: it echoes what the page writes, with no approval or setting.
let routed: Record<string, string | undefined> = {};
function RoutedUsagePage() {
  const [params, setParams] = React.useState<
    Record<string, string | undefined>
  >({ layoutId: 'costs', period: '30days' });
  routed = params;
  const initialFilters = React.useMemo(
    () => resolveUsagePageInitialFilters(params),
    [params],
  );
  const onLayoutChange = React.useCallback(
    (layoutId: string) => setParams((current) => ({ ...current, layoutId })),
    [],
  );
  const onFiltersChange = React.useCallback(
    (filters: Parameters<typeof buildUsageRouteParams>[0]) => {
      const { layoutId: _layoutId, ...owned } = buildUsageRouteParams(filters);
      setParams((current) => ({ ...current, ...owned }));
    },
    [],
  );
  return (
    <UsageWidgetPage
      initialFilters={initialFilters}
      onFiltersChange={onFiltersChange}
      onLayoutChange={onLayoutChange}
    />
  );
}

const visibleGeometry = {
  measureInWindow: (
    done: (x: number, y: number, width: number, height: number) => void,
  ) => done(0, 0, 1000, 300),
};

describe('Usage Sources: Agents or Your apps', () => {
  it("switches the same Costs widgets to the apps' collector calls at the viewer's prices and back, never summing the two", async () => {
    const collector = createTelemetryCollectorActionBoundary({ machineId: 'collector-1', accountId: 'account-a',
      serverIdentityId: 'srv_usage_apps_page', readCosts: (input) => ({ ok: true, source: input.source, since: input.since,
        until: input.until, items: [operand('gpt-5-mini', 3), operand('llama-3.3-70b', 1)],
        coverage: { callCount: 4, tokenCategoryCallCount: 4, reportedCostCallCount: 0, lostObservations: 0, reason: null } }) });
    daemonRpc.mockImplementation(collector.answerDaemonRpc);
    home = await serveActionHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-your-apps-page.test',
          accountId: 'account-a',
          serverIdentityId: 'srv_usage_apps_page',
          currentAccount: true,
        },
      ],
      route: (request) => {
        if (
          request.path === '/v1/features' ||
          request.path === '/v1/features/authenticated'
        )
          return Response.json(createRootLayoutFeaturesResponse());
        if (request.path === '/v1/kv/bulk')
          return Response.json({ values: [] });
        if (request.path === '/v2/usage/query')
          return Response.json(agentAccounting);
        if (request.path === '/v1/account/usage/prices')
          return Response.json(catalog);
        if (request.path === '/v1/deployments/environments')
          return Response.json({
            ok: true,
            nextCursor: null,
            coverage: 'complete',
            projectSources: [{ id: 'source-billing', name: 'billing-api' }],
            items: [
              {
                ...createDeploymentEnvironmentHeaderV1({
                  id: 'env-prod',
                  projectSourceId: 'source-billing',
                  telemetryMachineId: 'collector-1',
                }),
                name: 'Production',
              },
            ],
          });
        const collected = collector.handle(request);
        if (collected) return collected;
        return (
          createEmptyAccountBootstrapHttpResponse(request.path, {
            method: request.method,
          }) ??
          undefined
        );
      },
    });
    const server = home.homes.a!;
    withdrawProjection = collector.publishCommittedProjection(server.id);
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
              <CurrentContextPort />
              <RoutedUsagePage />
            </CurrentUiContextProvider>
          </AppPaneProvider>
        </MainAppTabStateProvider>
      </InjectedAuthProvider>,
      {
        createNodeMock: (node) =>
          node.props.testID === 'usage-page'
            ? { getInnerViewRef: () => visibleGeometry }
            : visibleGeometry,
      },
    );
    await act(async () =>
      screen
        .findByTestId('usage-page')!
        .props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 900 } },
        }),
    );
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const filters = (): readonly UsageWidgetPageFilter[] =>
      screen.findByType(UsageFilterBar).props.scopeFilters;
    const sources = () =>
      filters().find((filter) => filter.field === 'sources');
    const costFacts = () =>
      screen.findAllByType(UsageCostFactsWidget)[0]?.props.slice;

    // Agents lead; the one Sources chooser offers Your apps once the viewer has an app with a collector.
    await waitForHomeGovernance(() =>
      expect(sources()?.options.map((option) => option.id)).toContain(
        USAGE_SOURCES_SHOW_APPS,
      ),
    );
    expect(sources()?.shown).toBe('agents');
    expect(filters().map((filter) => filter.field)).toEqual([
      'sources',
      'agents',
      'machines',
      'projects',
    ]);

    await act(async () => {
      await sources()!.select(USAGE_SOURCES_SHOW_APPS);
    });
    await flushHookEffects({ cycles: 40 });
    expect(JSON.parse(routed.scope!).sources).toEqual([
      usageAppCallsSourceId('env-prod'),
    ]);
    await waitForHomeGovernance(() => {
      expect(filters().map((filter) => filter.field)).toEqual([
        'sources',
        'environments',
      ]);
      expect(sources()?.shown).toBe('apps');
      expect(costFacts()?.costFactTotals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'api_equivalent', amountUsd: 6 }),
          expect.objectContaining({
            kind: 'unpriced',
            eventCount: 1,
            amountUsd: null,
          }),
        ]),
      );
    });
    expect(collector.reads).toContainEqual(
      expect.objectContaining({ source: expect.objectContaining({ environmentId: 'env-prod' }) }),
    );
    expect(
      home.httpRequests
        .filter((request) => request.path === '/v2/usage/query')
        .some((request) => JSON.stringify(request.body).includes('app_calls:')),
      'App calls never reach the Agents ledger',
    ).toBe(false);

    await act(async () => {
      await sources()!.select(USAGE_SOURCES_SHOW_AGENTS);
    });
    await flushHookEffects({ cycles: 40 });
    expect(JSON.parse(routed.scope!).sources).toEqual([]);
    await waitForHomeGovernance(() => {
      expect(sources()?.shown).toBe('agents');
      expect(
        costFacts()?.costFactTotals?.some(
          (fact: { kind: string }) => fact.kind === 'unpriced',
        ),
      ).toBe(false);
    });
  });
});
