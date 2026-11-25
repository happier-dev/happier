import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryBatchRequestSchema, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageScore } from '@happier-dev/plugin-ui/presentation';
import { UsageSessionEvidenceRequestSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { executeUsageAction } from '@happier-dev/protocol/actions/executor/usageActions';
import { resolveUsagePageAggregation, type UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsageQueryWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';

import { createDeferred, expandDisclosureAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
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
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

const { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const { captureUiUsageQueryAccountContext, getUsageQueryResourceStore, invalidateUsageQueryResources } =
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
const { UsageScoreBody } = await import('./widgets/UsageChartStyleBodies');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { UsageBodyReadFailed, UsageCoverageLine, usageSourceTitle } = await import('./widgets/usageBodyKit');
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
  scrollTo: () => {},
  measureInWindow: (
    done: (x: number, y: number, width: number, height: number) => void,
  ) => done(0, 0, viewport.width, 300),
};

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let readFails = false;
let refuseRead = false;
let readHeld: { promise: Promise<Response>; release: () => void } | null = null;
let restorePopoverGlobals: (() => void) | undefined;

beforeEach(() => {
  Object.assign(viewport, { width: 390, height: 844 });
  readFails = false;
  refuseRead = false;
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone)',
    maxTouchPoints: 1,
  });
});

afterEach(async () => {
  standardCleanup();
  restorePopoverGlobals?.();
  restorePopoverGlobals = undefined;
  vi.unstubAllGlobals();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
  vi.restoreAllMocks();
});

async function renderUsagePage(
  layoutId = 'overview',
  response = accounting,
  beforeRender?: (serverId: string) => Promise<void>,
  sessionId?: string,
  sources?: string[],
  failures?: {
    savedViewsUnread: boolean;
    viewsReads: number;
    batch: (queries: readonly UsageAnalyticsQueryRequest[]) => Response;
  },
  privateEvidence?: {
    period: ReturnType<typeof normalizeUsageQuery>['period'];
    timeZoneOffsetMinutes: number;
    read: (body: unknown) => Promise<Response>;
  },
) {
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
      request.path === '/v2/usage/session-evidence' && privateEvidence
        ? privateEvidence.read(request.body)
        : request.path === '/v1/features' ||
      request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : request.path === '/v1/kv/bulk'
          ? Response.json({ values: [] })
          : request.path === '/v2/usage/query-batch'
            ? failures ? failures.batch(UsageAnalyticsQueryBatchRequestSchema.parse(request.body).queries)
              : refuseRead
              ? Response.json({ v: 1, results: UsageAnalyticsQueryBatchRequestSchema.parse(request.body).queries.map(query => ({ query, error: 'not_found' })) })
              : undefined
          : request.path === '/v2/usage/query'
            ? readHeld ? readHeld.promise : readFails
              ? Response.json({ error: 'unavailable' }, { status: 503 })
              : Response.json(response)
            : request.path === '/v1/artifacts' && request.method === 'GET'
                && request.url.searchParams.get('kind') === 'widget_area_layout' && failures
              ? (++failures.viewsReads, failures.savedViewsUnread
                ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 })
                : artifacts.handle(request.url.toString(), { method: request.method }) ?? undefined)
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
  await beforeRender?.(server.id);
  const chrome = (<UsageWidgetPage
    sessionId={sessionId}
    initialFilters={{
      layoutId,
      period: privateEvidence ? '30days' : '7days',
      metric: layoutId === 'costs' ? 'cost' : 'tokens',
      costMode: 'auto',
      focus: null,
      scope: privateEvidence || sources
        ? { period: privateEvidence?.period ?? { relative: '7days' }, agents: [], machines: [], projects: [], sources: sources ?? [], session: null, costBasis: 'auto' }
        : undefined,
      queryOverrides: privateEvidence ? { timeZoneOffsetMinutes: privateEvidence.timeZoneOffsetMinutes } : undefined,
    }}
  />);
  const renderOptions = {
    createNodeMock: (node: React.ReactElement<{ testID?: string }>) => node.props.testID === 'usage-page'
      ? { getInnerViewRef: () => visibleContentGeometry } : visibleContentGeometry,
  };
  if (failures) publishAppliedActiveServerRuntimeAvailability(true);
  const screen = failures ? await (await import('@/dev/testkit/harness/mountedCurrentUiContext')).renderMountedCurrentUiContext(chrome, renderOptions) : await renderScreen(
    <InjectedAuthProvider credentials={credentials}>
      <MainAppTabStateProvider>
        <AppPaneProvider>
          <CurrentUiContextProvider>
            {chrome}
          </CurrentUiContextProvider>
        </AppPaneProvider>
      </MainAppTabStateProvider>
    </InjectedAuthProvider>,
    renderOptions,
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
// USAGE-ACCEPT 1122 #30: with no chooser a phone could not reach the other views and did not name the current one.
// A phone chooses a view through the bar's folded picker; arranging (+ and ⋯) stays desktop work (D23).
it('lets a phone choose a view without arranging, and keeps arranging on a wide window', async () => {
  const phone = await renderUsagePage();
  await waitForHomeGovernance(() =>
    expect(phone.findAllByType(UsageFilterBar)).toHaveLength(1),
  );
  const phoneBar = phone.findAllByType(WidgetAreaLayoutBar);
  expect(phoneBar).toHaveLength(1);
  expect(phoneBar[0]!.props.layouts.length).toBeGreaterThan(1);
  expect(phoneBar[0]!.props.onCreate ?? null).toBeNull();
  expect(phoneBar[0]!.props.actions ?? null).toBeNull();
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

// r230 #79: while the page reads, the phone's header line says the short word on one line, so the page does not
// drop when the one-line "As of … · Partial" arrives; Details holds the sentence.
it('holds the phone header to one line while the page reads', async () => {
  let release = () => {};
  const promise = new Promise<Response>(resolve => { release = () => resolve(Response.json({ error: 'unavailable' }, { status: 503 })); });
  readHeld = { promise, release };
  try {
    const phone = await renderUsagePage('costs');
    const line = () => phone.findAllByType(SurfaceFreshnessLine)
      .find(candidate => candidate.props.testID === 'usage-page.header.reading');
    await waitForHomeGovernance(() => expect(line()).toBeDefined());
    expect(line()!.props.reason).toBe(t('usage.board.page.loading'));
    const actions = (line()!.props.actions ?? (line()!.props.action ? [line()!.props.action] : [])) as readonly { testID?: string }[];
    expect(actions.map(action => action.testID)).toEqual(['usage-page.header.reading.detail']);
  } finally { readHeld = null; release(); }
});

it.each([
  { width: 1440, refused: true },
  { width: 390, refused: true },
  { width: 1440, refused: false },
  { width: 390, refused: false },
])('preserves only actionable recovery for a Usage read at $width (refused: $refused)', async ({ width, refused }) => {
  Object.assign(viewport, { width, height: 900 });
  if (width === 1440) vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 });
  refuseRead = refused;
  readFails = !refused;
  const screen = await renderUsagePage('costs', accounting, undefined, undefined, ['codex-native']);
  const line = () => screen.findAllByType(SurfaceFreshnessLine).find(candidate =>
    ['usage-page.header.failed', 'usage-page.header.scopeRefused'].includes(candidate.props.testID));
  await waitForHomeGovernance(() => expect(line()).toBeDefined());
  const actions = (line()?.props.actions ?? (line()?.props.action ? [line()!.props.action] : [])) as
    readonly { testID?: string; onPress: () => void }[];
  expect(actions.some(action => action.testID === 'usage-page.header.retry')).toBe(!refused);
  if (!refused) return;

  expect(line()?.props.tone).toBe('neutral');
  expect(screen.getTextContent()).not.toContain('denied');
  const chooser = width === 390 ? 'usage-filters.scope' : 'usage-filters.sources';
  const otherChooser = width === 390 ? 'usage-filters.sources' : 'usage-filters.agents';
  const expanded = (id: string) => {
    const props = screen.findHostByTestId(id)?.props;
    return props?.['aria-expanded'] ?? props?.accessibilityState?.expanded;
  };
  expect(expanded(chooser)).toBe(false);
  const changeScope = actions.find(action => action.testID === 'usage-page.header.scopeRefused.changeScope');
  expect(changeScope).toBeDefined();
  restorePopoverGlobals = withPopoverWebGlobals();
  await screen.pressByTestIdAsync('usage-page.header.scopeRefused.changeScope');
  expect(expanded(chooser)).toBe(true);
  expect(expanded(otherChooser)).not.toBe(true);
});

it.each([
  { label: 'refusal only', refused: true, transient: false, views: false },
  { label: 'transient only', refused: false, transient: true, views: false },
  { label: 'refusal and transient in one batch', refused: true, transient: true, views: false },
  { label: 'refusal and unread Views', refused: true, transient: false, views: true },
  { label: 'transient and unread Views', refused: false, transient: true, views: true },
  { label: 'refusal, transient and unread Views', refused: true, transient: true, views: true },
])('J-B30 Usage page keeps each outcome and one recovery for $label', async ({ refused, transient, views }) => {
  Object.assign(viewport, { width: 1440, height: 900 });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 });
  let recover = false;
  const batches: UsageAnalyticsQueryRequest[][] = [];
  const isRefused = (query: UsageAnalyticsQueryRequest) => refused && query.includeSeries === true;
  const failures = {
    savedViewsUnread: views,
    viewsReads: 0,
    batch(queries: readonly UsageAnalyticsQueryRequest[]) {
      batches.push([...queries]);
      return Response.json({ v: 1, results: queries.map(query => isRefused(query)
        ? { query, error: 'not_found' }
        : transient && !recover ? { query, error: 'usage_query_failed' } : { query, value: accounting }) });
    },
  };
  const screen = await renderUsagePage('overview', accounting, undefined, undefined, ['codex-native'], failures);
  const retries = () => screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === t('common.retry'));
  const notices = () => screen.findAllByType(SurfaceFreshnessLine)
    .filter(line => line.props.testID?.startsWith('usage-page.header.')).map(line => line.props.reason);
  const refusal = t('usage.board.page.scopeReadRefused');
  const viewsFailed = t('usage.board.page.viewsReadFailed');
  const readFailed = t('usage.board.page.coverageFailed', { sources: usageSourceTitle('accounting') });
  await waitForHomeGovernance(() => {
    if (refused) expect(notices()).toContain(refusal);
    if (views) expect(notices().some(reason => reason?.includes(viewsFailed))).toBe(true);
    if (transient) expect(notices().some(reason => reason?.includes(readFailed))).toBe(true);
    expect(retries()).toHaveLength(transient || views ? 1 : 0);
  });
  if (refused && transient) expect(batches.some(batch => batch.some(isRefused) && batch.some(query => !isRefused(query)))).toBe(true);
  if (refused) {
    expect(screen.findHostByTestId('usage-page.header.scopeRefused.changeScope')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('denied');
    await expandDisclosureAsync(screen.findAllByTestId('usage-page.header.scopeRefused.technicalDetails'));
    expect(screen.getTextContent()).toContain('denied');
  }
  if (!transient && !views) return;
  const lastBatch = batches.length;
  const lastViewsReads = failures.viewsReads;
  recover = true;
  failures.savedViewsUnread = false;
  await screen.pressByTestIdAsync(transient ? 'usage-page.header.retry' : 'usage-page.header.viewsRetry');
  await waitForHomeGovernance(() => {
    if (transient) expect(batches.length).toBeGreaterThan(lastBatch);
    if (views) expect(failures.viewsReads).toBeGreaterThan(lastViewsReads);
    expect(retries()).toHaveLength(0);
  });
  expect(batches.slice(lastBatch).flat().some(isRefused)).toBe(false);
  if (refused) expect(notices()).toContain(refusal);
});

it('J-B30 a host without a Usage header discloses a refusal and recovers a sibling', async () => {
  home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-tile.test', accountId: 'account-a' }] });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  publishAppliedActiveServerRuntimeAvailability(true);
  const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
  const query = normalizeUsageQuery({});
  const slice = {
    key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query, pending: false,
    sources: [
      { source: 'accounting', status: 'error', errorCode: 'denied' },
      { source: 'quota', status: 'error', errorCode: 'quota_read_failed' },
    ] as const,
  };
  const onRetry = vi.fn();
  const render = async (variant: 'line' | 'body') => {
    const Component = variant === 'line' ? UsageCoverageLine : UsageBodyReadFailed;
    return renderMountedCurrentUiContext(<Component slice={{ ...slice, sources: [...slice.sources] }} sources={['accounting', 'quota']}
      testID={'mixed.' + variant} onRetry={onRetry} />);
  };
  for (const variant of ['line', 'body'] as const) {
    const screen = await render(variant);
    expect(screen.getTextContent()).toContain(t('usage.board.page.scopeReadRefused'));
    const retries = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === t('common.retry'));
    expect(retries).toHaveLength(1);
    await act(async () => { retries[0]!.props.onPress(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    onRetry.mockClear();
  }
});

it('only shows the quiet refusal for a fixed shared Session', async () => {
  refuseRead = true;
  const sessionId = 'session-usage-scope-refused';
  const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
  const screen = await renderUsagePage('overview', accounting, async serverId => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applySessions([createSessionFixture({
      id: sessionId, serverId, access: createSessionAccessFixture('view'),
    })]);
  }, sessionId);
  await waitForHomeGovernance(() => expect(screen.findAllByType(SurfaceFreshnessLine).some(line =>
    line.props.testID === 'usage-page.header.scopeRefused')).toBe(true));
  expect(screen.findByTestId('usage-page.header.retry')).toBeNull();
  expect(screen.findByTestId('usage-page.header.scopeRefused.changeScope')).toBeNull();
  expect(screen.getTextContent()).not.toContain(t('usage.board.page.sessionRecipientSubtitle'));
  expect(screen.getTextContent()).not.toContain('denied');
  await expandDisclosureAsync(screen.findAllByTestId('usage-page.header.scopeRefused.technicalDetails'));
  expect(screen.getTextContent()).toContain('denied');
});

it.each(['view', 'owner'] as const)('qualifies the scope of the Session Usage page for %s access', async level => {
  const sessionId = 'session-usage-scope';
  const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
  const screen = await renderUsagePage('overview', {
    ...accounting,
    totals: { ...totals, eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }, async serverId => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applySessions([createSessionFixture({
      id: sessionId, serverId, access: createSessionAccessFixture(level),
    })]);
  }, sessionId);
  const sharedCaption = 'Your account’s usage in this session.';
  const ownerCaption = t('usage.board.page.sessionSubtitle');
  const text = screen.getTextContent();
  expect(text.split(sharedCaption).length - 1).toBe(level === 'view' ? 1 : 0);
  expect(text.includes(ownerCaption)).toBe(level === 'owner');
});

it('shows offline Work in the Usage header without Retry', async () => {
  const sessionId = 'offline-work-session';
  const phone = await renderUsagePage('work', {
    ...accounting,
    sessionMembership: { turns: [{ sessionId, turnId: 'turn', executions: ['happier'] }] },
  }, async serverId => {
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const scope = { serverId, accountId: 'account-a' };
    const machine = createHydratedPlainMachineFixture({
      id: 'offline-work-machine', accountId: scope.accountId,
      machine: { active: false, activeAt: 1, presenceProtocolVersion: 1 },
    });
    await publishMachineInventoryForTest(scope, [machine]);
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId, active: true,
      metadata: { machineId: machine.id, path: '/repo', host: 'test', homeDir: '/home/test' },
    })]);
  });
  const header = () => phone.findAllByType(SurfaceFreshnessLine)
    .find(candidate => candidate.props.testID?.startsWith('usage-page.header.'));
  await waitForHomeGovernance(() => expect(header()?.props.reason).toBe(t('usage.board.page.workMachinesOffline')));
  const actions = [header()?.props.action, ...(header()?.props.actions ?? [])];
  expect(actions.map(action => action?.label)).not.toContain(t('common.retry'));
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
  // A phone's notice beside its actions wraps or stacks, never ellipsizes mid-word ("No usage i…", acceptance 11-21 #17).
  expect(line()!.props.presentation).toBe('line');
  const details = actions.find(action => action.label === t('common.details'));
  expect(details).toBeDefined();
  await act(async () => { details!.onPress(); });
  expect(line()!.props.asOf).toBe(readAt);
  expect(line()!.props.reason).toContain(usageSourceTitle('claude-sdk-result', undefined, 'coverage'));
  expect(line()!.props.reason).toContain(formatUsageObservedAt(sourceAt));
});

const hour = Date.UTC(2026, 10, 15, 14);
const exact = normalizeUsageQuery({
  period: { startMs: Date.UTC(2026, 9, 24, 23), endMs: Date.UTC(2026, 10, 23, 23) },
  granularity: 'day', timeZoneOffsetMinutes: 60, activityResolution: 'both',
  includeAccounting: true, includeActivity: true, includeSessionEvidence: true,
  includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuota: false, includeCoach: false,
});
const firstStart = hour + 60_000;
const spans = [
  { subject: 'fixture-observed', startMs: firstStart, endMs: firstStart + 495_019 },
  { subject: 'fixture-unread', startMs: hour + 700_000, endMs: hour + 742_151 },
];
const raw = spans.map(span => {
  const record = createPlainSessionWithDisplayRecordFixture({
    id: span.subject, createdAt: span.startMs, updatedAt: span.endMs,
    seq: 1, active: false, activeAt: span.endMs, metadataVersion: 1, agentStateVersion: 1,
  });
  const turns = { v: 1 as const, sessionId: span.subject, updatedAt: span.endMs, turns: [{
    turnId: 'fixture-turn', agentId: 'muse', status: 'completed' as const,
    startedAt: span.startMs, terminalAt: span.endMs, updatedAt: span.endMs,
  }] };
  return { record, turns };
});
function evidenceResponse(body: unknown) {
  const { requests } = UsageSessionEvidenceRequestSchema.parse(body);
  const selections = requests.map(demand => ({ query: demand.query,
    sessionIds: demand.sessionIds ?? spans.map(span => span.subject) }));
  const selected = new Set(selections.flatMap(row => row.sessionIds));
  return Response.json({ requests: selections, results: raw.flatMap(({ record, turns }, index) => {
    if (!selected.has(record.id)) return [];
    return [index === 1
      ? { sessionId: record.id, detail: { status: 403, body: { error: 'encrypted_access_pending' } } }
      : { sessionId: record.id, detail: { status: 200, body: { session: record } },
          turns: { status: 200, body: turns },
          ...(requests.some(request => request.query.includeTranscriptEvidence)
            ? { messageEvidence: {}, messagesComplete: false } : {}) }];
  }) });
}

it('keeps the typed cause with the mounted Score hour while its exact replacement is pending', async () => {
  vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-60);
  let holdEvidence: ReturnType<typeof createDeferred<void>> | undefined;
  const screen = await renderUsagePage('agents', accounting, undefined, undefined, undefined, undefined, {
    period: exact.period, timeZoneOffsetMinutes: exact.timeZoneOffsetMinutes,
    read: async body => {
      await holdEvidence?.promise;
      return evidenceResponse(body);
    },
  });
  await waitForHomeGovernance(() => {
    const props = screen.findAllByType(UsageScoreBody)[0]?.props;
    expect({
      chart: screen.findAllByType(UsageScore).length > 0,
      body: Boolean(props),
      offset: props?.query.timeZoneOffsetMinutes,
      period: props?.query.period,
      sources: props?.slice.sources.map(({ source, status, errorCode }: { source: string; status: string; errorCode?: string }) => ({source, status, errorCode})),
      busy: props?.slice.howYouWork?.agentCalendar?.coverage.busy,
      recorded: props?.slice.howYouWork?.agentCalendar?.hours.find((bucket: { startMs: number }) => bucket.startMs === hour)?.agents.map((agent: { metrics: { busyMs: number } }) => agent.metrics.busyMs),
    }).toMatchObject({ chart: true });
  });
  const chart = screen.findAllByType(UsageScore)[0]!;
  const displayed = chart.props.model.rows.find((row: { agentId: string }) => row.agentId === 'muse');
  expect(chart.props.model.byWeekday).toBe(true);
  const pageMs = displayed.hours[6][15] * 60_000;
  expect(displayed.hours[6][16]).toBeNull();
  expect(pageMs).toBeCloseTo(495_019, 5);
  await waitForHomeGovernance(() => expect(screen.findAllByType(SurfaceFreshnessLine)
    .some(line => line.props.testID === 'usage-page.header.partial')).toBe(true));
  const notice = screen.findAllByType(SurfaceFreshnessLine).find(line => line.props.testID === 'usage-page.header.partial')!;
  if (notice.props.actions?.length) {
    await act(async () => notice.props.actions[0].onPress());
  }
  expect(screen.findAllByType(SurfaceFreshnessLine).find(line => line.props.testID === 'usage-page.header.partial')!.props.reason)
    .toMatch(/some sessions.+activity|showing what arrived|not every session/i);

  const page = screen.findAllByType(UsageScoreBody)[0]!.props;
  expect(page.slice.pending).toBe(false);
  expect(page.slice.sources).toContainEqual(expect.objectContaining({
    source: 'how_you_work:sessions', status: 'partial', errorCode: 'encrypted_access_pending',
  }));
  const scope = captureActiveServerAccountScopeLifetime()!.scope;
  const executeMounted = createFrontDoorActionExecute();
  const usageInput = { queries: [page.query] };
  const invokeMounted = () => executeMounted('usage.query', usageInput, {
    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: scope.serverId, expectedAccountId: scope.accountId,
  });
  // The exact Action batch can reuse the page’s admitted hour while its own
  // evidence response is still open. Keep that read in flight for this check.
  holdEvidence = createDeferred<void>();
  const gate = holdEvidence;
  let firstMounted: Awaited<ReturnType<typeof invokeMounted>>;
  try {
    firstMounted = await invokeMounted();
  } finally {
    gate.resolve();
    holdEvidence = undefined;
  }
  if (!firstMounted.ok) throw new Error(firstMounted.errorCode);
  const readSlice = (result: unknown) => (result as UsageQueryBatchResult).results[0]!;
  const opening = readSlice(firstMounted.result);
  const readMuseHour = (result: UsageQueryBatchResult['results'][number]) => result.howYouWork?.agentCalendar?.hours
    .find(bucket => bucket.startMs === hour)?.agents.find(agent => agent.agentId === 'muse');
  expect(opening.pending).toBe(true);
  expect(readMuseHour(opening)?.coverage.busy).toBe('partial');
  expect(readMuseHour(opening)?.metrics.busyMs).toBe(495_019);
  const openingCause = opening.sources.find(source => source.source === 'how_you_work:sessions')?.errorCode;
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
  const account = captureUiUsageQueryAccountContext(credentials)!;
  const { projectNativeJsonValueForTransport } = await import('@happier-dev/protocol/json/strictJsonValue');
  const entry = getUsageQueryResourceStore(account).getEntry({
    hostRead: 'usage.query', input: projectNativeJsonValueForTransport(usageInput),
  });
  if (opening.pending) {
    expect(opening.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
    const settled = await entry.acquire();
    expect(settled.error).toBeUndefined();
  }
  const mounted = await invokeMounted();
  if (!mounted.ok) throw new Error(mounted.errorCode);
  const mountedResult = readSlice(mounted.result);
  expect(mountedResult.pending).toBe(false);
  expect(mountedResult.sources).toContainEqual(expect.objectContaining({
    source: 'how_you_work:sessions', status: 'partial', errorCode: 'encrypted_access_pending',
  }));
  const mountedHour = readMuseHour(mountedResult);
  expect(mountedHour?.coverage.busy).toBe('partial');
  expect(mountedHour?.metrics.busyMs).toBe(495_019);
  expect(mountedHour).toEqual(readMuseHour(page.slice));
  expect(mountedResult.howYouWork?.agentCalendar?.weekdayHourBuckets.find(bucket => bucket.weekday === 0 && bucket.hour === 15)
    ?.agents.find(agent => agent.agentId === 'muse')?.metrics.busyMs).toBe(495_019);

  const sessions = raw.map(({ record, turns }) => ({
    id: record.id, metadata: null, agentState: null, sessionTurns: turns,
  }));
  // Same Action executor and aggregation as the CLI, with its independently opened native evidence supplied at the read port.
  const action = await executeUsageAction('usage.query', usageInput, {
    query: async ({ queries }) => resolveUsagePageAggregation({
      queries, nowMs: Date.UTC(2026, 10, 24, 16),
      accounting: queries.map(query => ({ query, value: accounting, status: 'available' })),
      howYouWork: queries.map(query => ({ query, detail: projectUsageQueryWorkEvidence({ query, sessions }) })),
    }, bundledUsageModelPriceCatalog),
  }, { surface: 'cli' });
  expect(action.ok).toBe(true);
  if (!action.ok) return;
  const slice = action.result.results[0]!;
  const actionMs = slice.howYouWork?.agentCalendar?.hours.find(bucket => bucket.startMs === hour)
    ?.agents.find(agent => agent.agentId === 'muse')?.metrics.busyMs;
  expect(actionMs).toBe(537_170);
  expect(slice.pending).toBe(false);
  expect(actionMs! - pageMs).toBeCloseTo(42_151, 5);

  await screen.unmount();
  expect(openingCause, 'a pending Action with a retained partial hour carries the typed cause').toBe('encrypted_access_pending');
});
