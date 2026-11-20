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
import { UsageBreakdownsBody } from '@happier-dev/plugin-ui/presentation';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { EmptyState } from '@/components/ui/empty/EmptyState';
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

async function mountUsagePageWithApps(items: readonly ReturnType<typeof operand>[]) {
    const callCount = items.reduce((sum, item) => sum + item.callCount, 0);
    const collector = createTelemetryCollectorActionBoundary({ machineId: 'collector-1', accountId: 'account-a',
      serverIdentityId: 'srv_usage_apps_page', readCosts: (input) => ({ ok: true, source: input.source, since: input.since,
        until: input.until, items: [...items],
        coverage: { callCount, tokenCategoryCallCount: callCount, reportedCostCallCount: 0, lostObservations: 0, reason: null } }) });
    daemonRpc.mockImplementation(collector.answerDaemonRpc);
    const mountedHome = await serveActionHomes({
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
    home = mountedHome;
    const server = mountedHome.homes.a!;
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
    return { screen, collector, filters, sources, costFacts };
}

const frameTitles = (screen: Awaited<ReturnType<typeof mountUsagePageWithApps>>['screen']) =>
  screen.findAllByType(WidgetFrame).map((frame) => frame.props.title);

describe('Usage Sources: Agents or Your apps', () => {
  it("switches the same Costs widgets to the apps' collector calls at the viewer's prices and back, never summing the two", async () => {
    const { screen, collector, filters, sources, costFacts } = await mountUsagePageWithApps(
      [operand('gpt-5-mini', 3), operand('llama-3.3-70b', 1)]);

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
    // App calls have no Agent: the Costs ranking by agent ranks the Environments that made them, under their name.
    await waitForHomeGovernance(() => {
      expect(frameTitles(screen)).toContain('Environments');
      expect(frameTitles(screen)).not.toContain('Agents');
      const ranking = screen.findAllByType(UsageBreakdownsBody)[0]?.props.model;
      expect(ranking?.blocks.map((block: { id: string }) => block.id)).toEqual(['source']);
      expect(ranking?.blocks[0].rows.map((row: { label: string }) => row.label)).toEqual(['Production']);
      // The money basis is said once, in the card's caption beside its period, never again on each row.
      const caption = String(screen.findAllByType(WidgetFrame).find((frame) => frame.props.title === 'Environments')?.props.source ?? '');
      const parts = caption.split(' · ');
      expect(parts).toHaveLength(2);
      for (const row of ranking!.blocks[0].rows as readonly { annotation?: string }[]) expect(row.annotation ?? '').not.toContain(parts[1]);
    });
    expect(screen.findByTestId('usage-page.cards')?.props.accessibilityElementsHidden).not.toBe(true);
    expect(
      mountedHome.httpRequests
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
      expect(frameTitles(screen)).toContain('Agents');
    });
    expect(screen.findByTestId('usage-page.appsNothingRecorded') ?? null).toBeNull();
  });

  it('says once, with its scene and a way to the apps, when the shown apps recorded no model call in the period', async () => {
    const { screen, sources } = await mountUsagePageWithApps([]);
    await waitForHomeGovernance(() => expect(sources()?.options.map((option) => option.id)).toContain(USAGE_SOURCES_SHOW_APPS));
    await act(async () => {
      await sources()!.select(USAGE_SOURCES_SHOW_APPS);
    });
    await flushHookEffects({ cycles: 40 });
    await waitForHomeGovernance(() => {
      const empty = screen.findAllByType(EmptyState).find((state) => state.props.testID === 'usage-page.appsNothingRecorded');
      expect(empty?.props).toEqual(expect.objectContaining({ scene: 'searchWaiting',
        primaryAction: expect.objectContaining({ testID: 'usage-page.appsNothingRecorded.action' }) }));
    });
    // Starting a session is the Agents' next step, not the apps'.
    expect(screen.findByTestId('usage-page.header.nothingRecordedAction') ?? null).toBeNull();
    // The scene says it once: the cards step aside (still reading, so the page keeps deciding) rather than each saying "Nothing yet".
    expect(screen.findByTestId('usage-page.cards')?.props.accessibilityElementsHidden).toBe(true);
    await flushHookEffects({ cycles: 40 });
    expect(screen.findAllByType(EmptyState).some((state) => state.props.testID === 'usage-page.appsNothingRecorded')).toBe(true);
  });
});
