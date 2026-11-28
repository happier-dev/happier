import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectNodeText, renderScreen as renderScreenAtHost, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { OverlayPortalProvider, OverlayPortalHost } from '@/components/ui/popover/OverlayPortal';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ConnectedServicePoolSelectionGetRequestV1Schema, type ConnectedServicePoolSelectionV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } from '@/text';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider } from '@/modal';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { captureUiUsageQueryAccountContext, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import {
  ConnectedServiceQuotaGetResultV1Schema,
  projectProviderAccountUsageQuotaReadV1,
  type ConnectedServiceQuotaGetResultV1,
} from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { deriveProviderAccountUsageDayQuotaHistoryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { BurnUpChart, ChartDatum } from '@happier-dev/plugin-ui/presentation';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { UsageWidgetBodyModel } from '../../useUsageWidgetResource';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { getPoolStrategyPresentation } from '@/sync/domains/connectedServices/connectedServicePoolPolicy';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { formatMoment } from '@/utils/datetime/formatMoment';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatUsageCost } from '@/utils/format/usageNumbers';

// Machine RPC, native confirmation and the served Home's HTTP transport are external boundaries.
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module,
);
const selectionTransport = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(selectionTransport);
});
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
    Platform: { isPad: true },
    useWindowDimensions: () => ({ width: 1000, height: 800, scale: 1, fontScale: 1 }),
  }),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const service = {
  pluginId: 'happier.agent.claude',
  localId: 'claude-subscription',
};
const query = normalizeUsageQuery({});

let previousSnapshot = getAppliedActiveServerSnapshot();
let comparisonHome: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
let mountedHome: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
let mountedProfile = AccountProfileSchema.parse({ id: 'mounted-account' });
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let previousProfile = storage.getState().profile;
let previousProfileScope = storage.getState().profileScope;
let restoreFrameBoundary: (() => void) | undefined;
let restoreActionModuleLoader: (() => void) | undefined;
beforeEach(async () => {
  restoreFrameBoundary = withPopoverWebGlobals();
  previousSnapshot = getAppliedActiveServerSnapshot();
  previousAvailable = isAppliedActiveServerRuntimeAvailable();
  previousProfile = storage.getState().profile;
  previousProfileScope = storage.getState().profileScope;
  mountedProfile = AccountProfileSchema.parse({ id: 'mounted-account' });
  mountedHome = await serveAccountHomes({ homes: [{ key: 'mounted', serverUrl: 'https://usage-plans-mounted.test', accountId: mountedProfile.id,
    profile: mountedProfile, currentAccount: true }], route: () => undefined });
  const home = mountedHome.homes.mounted!;
  publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: home.id, accountId: mountedProfile.id }, profile: mountedProfile });
});
afterEach(async () => {
  standardCleanup();
  restoreFrameBoundary?.();
  restoreActionModuleLoader?.(); restoreActionModuleLoader = undefined;
  selectionTransport.mockReset();
  await comparisonHome?.dispose(); comparisonHome = undefined;
  await mountedHome?.dispose(); mountedHome = undefined;
  (
    await import('@/sync/domains/scope/activeServerAccountScope')
  ).retireActiveServerAccountScopeLifetime();
  publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
  storage.setState({ profile: previousProfile, profileScope: previousProfileScope });
});

async function serveResetStartHome(serverUrl: string, options?: Readonly<{
  profile: ReturnType<typeof AccountProfileSchema.parse>;
  missingSummaryFor?: Readonly<{ id: string; observedAtMs: number }>;
}>) {
  let reading: ConnectedServiceQuotaGetResultV1 | null = null;
  const writes: Array<Readonly<{ path: string; accountId: string | null; body: unknown }>> = [];
  const baseline = createRootLayoutFeaturesResponse();
  const features = createRootLayoutFeaturesResponse({ capabilities: { session: { ...baseline.capabilities.session,
    pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } } } });
  const settings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
    'session.pending.resetStart.set': { approvalRequiredSurfaces: ['ui'] },
  } }) };
  comparisonHome = await serveAccountHomes({ homes: [{ key: 'reset', serverUrl, accountId: 'account-a', profile: options?.profile, currentAccount: true, settings }],
    route: async request => {
      const path = request.url.pathname;
      if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
      if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      if (path.endsWith('/provider-account-usage/day-summaries')) {
        const frontier = options?.missingSummaryFor;
        return Response.json({ summaries: [], missingDays: frontier ? [{
          dayStartAtMs: Math.floor(frontier.observedAtMs / DAY) * DAY, coverage: { observationCount: 1, frontier },
        }] : [] });
      }
      if (reading?.current) {
        const record = { content: { t: 'plain', v: reading.current },
          metadata: { fetchedAt: reading.current.fetchedAtMs, staleAfterMs: reading.current.staleAfterMs, status: 'ok' }, sources: [reading.source] };
        if (path.endsWith('/provider-account-usage/sources/resolve')) return Response.json({ source: reading.source,
          recordId: reading.current.recordId, providerAccountId: reading.current.recordKey.accountSubjectId,
          fetchedAt: reading.current.fetchedAtMs, staleAfterMs: reading.current.staleAfterMs });
        if (path.endsWith('/provider-account-usage/record')) return Response.json(record);
        if (path.endsWith('/provider-account-usage/history')) {
          if (request.method === 'PUT') return Response.json({ success: true });
          const { parseQualifiedConnectedAccountV4StructuredQueryValue } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec');
          const { QualifiedProviderAccountUsageHistoryRequestV4Schema } = await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
          const demand = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
            request.url.searchParams.get('query'));
          if ('projection' in demand) return Response.json({ projection: null, complete: false });
          return Response.json({ entries: (reading.history?.entries ?? []).map(entry => ({
            id: entry.id, observedAtMs: entry.observedAtMs,
            record: { ...record, content: { t: 'plain', v: entry.snapshot } },
          })), nextCursor: null });
        }
      }
      if (request.method === 'PATCH' && /^\/v2\/sessions\/[^/]+\/pending\/[^/]+\/action$/.test(path)) {
        const body = request.body;
        if (!body || typeof body !== 'object') return Response.json({ error: 'invalid-params' }, { status: 400 });
        const requestedAction = PendingRequestedActionV1Schema.parse(Reflect.get(body, 'requestedAction'));
        writes.push({ path, accountId: request.accountId, body });
        return Response.json({ ok: true, didUpdate: true, requestedAction });
      }
      return undefined;
    } });
  restoreActionModuleLoader = await installRealActionExecutorModuleLoader();
  const server = comparisonHome.homes.reset!;
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  return { server, credentials, requests: () => writes, setReading: (value: ConnectedServiceQuotaGetResultV1) => { reading = value; } };
}

type Meter = Readonly<{
  meterId: string;
  label: string;
  usedPct: number;
  resetAtMs: number;
  windowDurationMs: number;
}>;

function quotaRead(
  accountId: string,
  now: number,
  meters: readonly Meter[],
  extra: Record<string, unknown> = {},
  current: Record<string, unknown> = {},
): ConnectedServiceQuotaGetResultV1 {
  const recordKey = {
    providerId: 'anthropic',
    accountSubjectId: accountId,
    subjectKind: 'account',
    quotaScope: 'account',
  } as const;
  const recordId = buildProviderAccountUsageRecordId(recordKey);
  return ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId }, bindingKind: 'account' },
    current: {
      v: 1,
      recordId,
      recordKey,
      providerId: 'anthropic',
      accountSubject: { kind: 'providerSubject', id: accountId },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: HOUR,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: `Plan ${accountId}`,
      accountLabel: `Account ${accountId}`,
      meters: meters.map((meter) => ({
        ...meter,
        used: null,
        limit: null,
        utilizationPct: meter.usedPct,
        unit: 'count',
        status: 'ok',
        resetsAt: meter.resetAtMs,
      })),
      ...current,
    },
    pace: meters.map((meter) => ({
      meterId: meter.meterId,
      value: {
        status: 'available',
        window: {
          recordId,
          meterId: meter.meterId,
          resetAtMs: meter.resetAtMs,
          windowStartAtMs: meter.resetAtMs - meter.windowDurationMs,
          windowDurationMs: meter.windowDurationMs,
        },
        usedFraction: meter.usedPct / 100,
        elapsedFraction: 0.5,
        evenPaceFraction: 0.5,
        pace: meter.usedPct / 50,
        projectedResetUtilizationFraction: meter.usedPct / 50,
        qualification: 'confirmed',
        sampleCount: 7,
        empiricalRange: { min: 0.6, max: 0.9 },
        observedCurve: [
          { observedAtMs: now - HOUR, usedFraction: meter.usedPct / 200 },
          { observedAtMs: now, usedFraction: meter.usedPct / 100 },
        ],
      },
    })),
    targets: [],
    waitingWork: { status: 'unavailable', reason: 'unsupported' },
    ...extra,
  });
}

function bodyProps(
  quota: readonly ConnectedServiceQuotaGetResultV1[],
  pools?: Parameters<typeof resolveUsagePageAggregation>[0]['pools'],
  shownQuery = query,
  previous?: Parameters<typeof resolveUsagePageAggregation>[0]['previous'],
) {
  if (pools && pools.flatMap(read => read.value ?? []).some(pool => !storage.getState().profile.connectedAccountGroupsV4.some(group =>
    group.ref.groupId === pool.group.groupId && group.ref.service.pluginId === pool.group.service.pluginId
      && group.ref.service.localId === pool.group.service.localId))) {
    // Resource pool snapshots do not establish an Account's current group definitions.
    const snapshot = getAppliedActiveServerSnapshot();
    const serverId = snapshot.serverId ?? 'home';
    const accountId = storage.getState().profileScope?.accountId ?? 'detail-account';
    publishAppliedActiveServerSnapshot({ ...snapshot, serverId, serverUrl: snapshot.serverUrl || 'https://usage-detail.test' }, true);
    const profile = AccountProfileSchema.parse({ ...storage.getState().profile, id: accountId,
      connectedAccountGroupsV4: pools.flatMap(read => read.value ?? []).map(pool => QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: pool.group, displayName: pool.group.groupId, incarnation: `${pool.group.groupId}:1`,
        policy: { strategy: 'priority' }, generation: 1, runtimeStateRevision: 1, state: {}, members: [],
        activeConnectedAccountId: null, createdAt: 1, updatedAt: 1,
      })),
    });
    // The Home profile producer and its loaded projection describe the same current definitions.
    if (profile.id === mountedProfile.id) Object.assign(mountedProfile, profile);
    storage.setState({ profileScope: { serverId, accountId }, profile });
  }
  const slice = resolveUsagePageAggregation({
    queries: [shownQuery],
    nowMs: Date.now(),
    previous,
    quota: { status: 'available', value: [...quota] },
    ...(pools ? { pools } : {}),
  }, bundledUsageModelPriceCatalog).results[0]!;
  const model = {
    requestedQuery: null,
    shownQuery: null,
    slice,
    pending: false,
    error: null,
    freshness: 'fresh',
    updatingPreviousPeriod: false,
    refreshing: false,
    refresh: async () => {},
  } satisfies UsageWidgetBodyModel;
  return { model, slice, query: shownQuery, serverId: getAppliedActiveServerSnapshot().serverId! };
}

const wrap = (node: React.ReactElement, credentials: React.ComponentProps<typeof InjectedAuthProvider>['credentials'] = null) => (
  <InjectedAuthProvider credentials={credentials}>
    <ModalProvider><OverlayPortalProvider>{node}<OverlayPortalHost /></OverlayPortalProvider></ModalProvider>
  </InjectedAuthProvider>
);

// The canonical period owner maps 30D/90D to day and 1Y/All to month. Exercise each distinct UI path once.
it.each([...new Set((['30days', '90days', 'year', 'all'] as const).map(period => getUsagePeriodDefinition(period).granularity))])(
  'renders identical daily quota history for %s queries from detail and retained summaries, including a single-reading window and an intraday reset', async granularity => {
  const nowMs = Date.now();
  const cutoff = nowMs - 90 * DAY;
  const day = Math.floor(cutoff / DAY) * DAY - DAY;
  const recentDay = day + 2 * DAY;
  const currentDay = Math.floor(nowMs / DAY) * DAY;
  const sample = (at: number, used: number, resetAtMs: number) => {
    const read = quotaRead('retained', at, [{ meterId: 'hour', label: 'Hourly', usedPct: used, resetAtMs, windowDurationMs: HOUR }]);
    const snapshot = read.current!;
    snapshot.meters[0]!.used = used;
    snapshot.meters[0]!.limit = 1000;
    snapshot.meters[0]!.usedPct = used / 10;
    snapshot.meters[0]!.utilizationPct = used / 10;
    return snapshot;
  };
  const snapshots = [sample(day + 9.5 * HOUR, 20, day + 10 * HOUR),
    sample(day + 9.75 * HOUR, 35, day + 10 * HOUR),
    sample(day + 10.25 * HOUR, 7, day + 11 * HOUR),
    sample(recentDay + 9.25 * HOUR, 40, recentDay + 10 * HOUR),
    sample(nowMs - 1000, 60, nowMs + HOUR / 2)];
  const current = snapshots.at(-1)!;
  const source = quotaRead('retained', current.observedAtMs, []).source;
  const input = { source, projection: { range: { startAtMs: day, endAtMs: nowMs + 1 }, resolution: 'accepted_observations' as const } };
  const entries = snapshots.map((snapshot, index) => ({ id: String(index), observedAtMs: snapshot.observedAtMs, snapshot }));
  const detail = projectProviderAccountUsageQuotaReadV1({ input, current, daySummaries: [], nowMs,
    history: { entries, nextCursor: null } });
  const summaries = deriveProviderAccountUsageDayQuotaHistoryV1({ recordId: current.recordId, snapshots });
  const compacted = projectProviderAccountUsageQuotaReadV1({ input, current, nowMs,
    daySummaries: summaries.filter(summary => summary.dayStartAtMs < cutoff),
    history: { entries: entries.filter(entry => entry.snapshot.fetchedAtMs >= cutoff), nextCursor: null } });
  expect(compacted.pageFacts?.dayQuotaHistory).toEqual(detail.pageFacts?.dayQuotaHistory);
  const shownQuery = normalizeUsageQuery({ period: { startMs: day, endMs: nowMs + 1 }, granularity });
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const render = async (read: ConnectedServiceQuotaGetResultV1) => {
    const screen = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([read], undefined, shownQuery)} id="usage_projections" testID="daily" />));
    const chart = screen.findAllByType(BurnUpChart).find(node => node.props.testID === 'daily.dailyHistory');
    expect(chart).toBeTruthy();
    return chart!.props;
  };
  const fromDetail = await render(detail);
  const fromSummaries = await render(compacted);
  expect(fromSummaries.series).toEqual(fromDetail.series);
  expect(fromDetail.series.map((series: { points: readonly { x: number; y: number | null }[] }) => series.points.map(point => [point.x, point.y])))
    .toEqual([[[day, 7], [recentDay, 40], [currentDay, 60]], [[day, 35], [recentDay, 40], [currentDay, 60]]]);
  expect(fromSummaries.series[0].points[0].annotation).toContain(t('usage.board.plans.dailyHistoryReset', {
    time: formatUsageCalendarDate(day + 10 * HOUR, 0,
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), value: '35',
  }));
  // Compaction may supply daily facts but never an exact observation witness for a reset action.
  const allCompacted = projectProviderAccountUsageQuotaReadV1({ input, current, daySummaries: summaries, nowMs,
    history: { entries: [], nextCursor: null } });
  expect(allCompacted.pageFacts?.dayQuotaHistory).toEqual(detail.pageFacts?.dayQuotaHistory);
  expect(allCompacted.pageFacts?.resetWitness).toBeNull();
  expect(compacted.pageFacts?.resetWitness?.id).toBe(entries.at(-1)!.id);
});

// Native measurement is the physical boundary; Popover open/close, placement and portal owners run.
const renderScreen = async (node: Parameters<typeof renderScreenAtHost>[0]) => (await import('@/dev/testkit/harness/mountedCurrentUiContext')).renderMountedCurrentUiContext(node, {
  createNodeMock: () => ({
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(200, 200, 120, 32),
  }),
});

async function invokePlanCommand(title: string, input?: string, expected: object = { ok: true }) {
  const { executeCurrentUiContextAction } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
  const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
  if (!read.ok) throw new Error(read.errorCode);
  const command = CurrentUiContextSnapshotV1Schema.parse(read.result).commands.find(row => row.title === title);
  expect(command, title).toBeDefined();
  await act(async () => {
    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: command!.id, ...(input === undefined ? {} : { input }) },
      context: { surface: 'agent' } })).toMatchObject(expected);
  });
}

// Project the mounted host tree in web reading order. Generic labels and their visible children can both be exposed.
function spokenPlanText(node: ReactTestInstance): string[] {
  if (typeof node.type === 'string') {
    if (node.props['aria-hidden'] || node.props.accessibilityElementsHidden
      || node.props.importantForAccessibility === 'no-hide-descendants') return [];
    const label = node.props.accessibilityLabel;
    if (typeof label === 'string') {
      if (node.props.accessibilityRole === 'button') return [label];
      return [label, ...node.children.flatMap(child => typeof child === 'string' ? [child] : spokenPlanText(child))];
    }
  }
  return node.children.flatMap(child => typeof child === 'string' ? [child] : spokenPlanText(child));
}

async function renderPlanAccessibility(node: React.ReactElement) {
  const { UsageChartInteractions } = await import('../../usageChartInteractions');
  return renderScreen(wrap(<UsageChartInteractions>{node}</UsageChartInteractions>));
}

function expectProjectionRowReading(
  screen: Awaited<ReturnType<typeof renderPlanAccessibility>>,
  testID: string,
  caption: 'caption' | 'freshness',
  readingOrder: readonly string[],
) {
  const captionID = `${testID}.${caption}`;
  let row = screen.findHostByTestId(captionID)?.parent;
  while (row && !row.findAll(node => typeof node.type === 'string' && node.props.testID === testID).length) {
    row = row.parent;
  }
  while (row && (row.props['aria-hidden'] || typeof row.type !== 'string')) {
    row = row.parent;
  }
  expect(row, captionID).toBeTruthy();
  const reading = spokenPlanText(row!).join(' ');
  let start = 0;
  for (const phrase of readingOrder) {
    expect.soft(reading.split(phrase), reading).toHaveLength(2);
    const position = reading.indexOf(phrase, start);
    expect.soft(position, `${phrase} in ${reading}`).toBeGreaterThanOrEqual(start);
    start = Math.max(start, position + phrase.length);
  }
}

it('presents an already exhausted window as used up in chart and list projections', async () => {
  const now = Date.now();
  const read = quotaRead('spent', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 100,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  for (const style of ['chart', 'list'] as const) {
    const screen = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([read])} id="usage_projections"
      presentation={{ style }} testID="spent" />));
    expect(screen.getTextContent()).not.toContain(t('usage.board.plans.projectionRunsOutLabel'));
    expect(screen.getTextContent()).not.toContain(t('usage.board.plans.projectionRunsOut', { time: formatMoment(now, now) }));
    expect(screen.getTextContent()).toContain(t('usage.board.plans.cellUsedUp'));
    expect(screen.getTextContent()).toContain(formatMoment(now + DAY, now));
    expect(screen.findByTestId('spent.headline.beforeReset')).toBeNull();
    await screen.unmount();
  }
});

it('reveals exact projected percent points without rounding the admitted projection headline', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([read])} id="usage_projections" testID="proj" />));
  expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'proj.headline.detail')?.props.datum.value).toBe('60.25%');
});

it.each(['runs out', 'rounded percentage'] as const)('reads the Projections hero value first (%s)', async branch => {
  const now = Date.now();
  const depletesAtMs = branch === 'runs out' ? now + 3 * HOUR : null;
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const quota = depletesAtMs === null ? read : ConnectedServiceQuotaGetResultV1Schema.parse({
    ...read, pace: read.pace.map(row => ({ ...row, value: { ...row.value, depletesAtMs } })),
  });
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderPlanAccessibility(<UsageProjectionsWidget {...bodyProps([quota])} id="usage_projections" testID="proj" />);
  const datum = screen.findAllByType(ChartDatum).find(node => node.props.testID === 'proj.headline.detail');
  expect(datum).toBeDefined();
  const reading = spokenPlanText(datum!.parent!).join(' ').replace(/\s/g, ' ');
  const value = depletesAtMs === null ? '~60%' : formatMoment(depletesAtMs, now).replace(/\s/g, ' ');
  const caption = t(depletesAtMs === null ? 'usage.board.plans.projectionUsedAtReset' : 'usage.board.plans.projectionRunsOutLabel');
  expect(reading.slice(0, value.length), reading).toBe(value);
  expect(reading.indexOf(caption)).toBeGreaterThan(reading.indexOf(value));
  expect(reading.split(value)).toHaveLength(2);
  expect(reading).toContain(t('usage.board.plans.estimatedFrom', { count: 7 }));
});

it('reads the no-tooltip Projections estimate once beside its label', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderPlanAccessibility(<UsageProjectionsWidget {...bodyProps([read])} id="usage_projections" testID="proj" />);
  expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'proj.headline.detail')).toBeUndefined();
  const headline = screen.findHostByTestId('proj.headline')!;
  const reading = spokenPlanText(headline).join(' ');
  const value = '~60%';
  const label = t('usage.board.plans.projectionUsedAtReset');
  expect(reading.indexOf(label), reading).toBeGreaterThanOrEqual(0);
  expect(reading.indexOf(value)).toBeGreaterThan(reading.indexOf(label));
  expect(reading.split(value), reading).toHaveLength(2);
});

it('reads the no-tooltip Plan fit price once', async () => {
  const now = Date.now();
  const amount = 17;
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }], {}, {
    subscription: { status: 'unavailable', renewal: 'unknown', observedAtMs: now, staleAfterMs: HOUR,
      enteredMonthlyPrice: { amount, currency: 'USD', enteredAtMs: now } },
  });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const { formatUsageCost } = await import('@/utils/format/usageNumbers');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />);
  expect(screen.findHostByTestId('fit.plan.work.figure')).toBeNull();
  const reading = spokenPlanText(screen.findHostByTestId('fit.plan.work')!).join(' ');
  const value = formatUsageCost(amount, 'USD');
  const label = t('usage.board.plans.planValueTitle');
  expect(reading.startsWith(`${label}:`), reading).toBe(true);
  expect(reading.split(value), reading).toHaveLength(2);
});

it('reads the compact Plan fit value once before its account caption', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const props = bodyProps([read]);
  const slice = { ...props.slice, planInsights: {
    recordedWeek: { status: 'insufficient_basis', reason: 'recorded_activity_unavailable' },
    accounts: [{ source: read.source, weather: [], pricePerReset: [], modelHeadroom: [],
      value: { status: 'available', kind: 'api_equivalent', amountUsd: 55.3, currency: 'USD', period: {},
        coverage: 'complete', pricedContributionCount: 1, unpricedContributionCount: 0, unknownAccountContributionCount: 0,
        pricingSources: ['fixture'], priceMultiple: { status: 'available', multiple: 2.765, priceKind: 'entered',
          priceAmount: 20, currency: 'USD', priceAsOfMs: now, priceSource: 'fixture',
          period: { startAtMs: now - DAY, endAtMs: now }, method: 'observed_api_equivalent_divided_by_period_price' } },
    }],
  } } satisfies typeof props.slice;
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...props} slice={slice} id="usage_plan_fit" testID="fit" />);
  const row = screen.findHostByTestId('fit.plan.work')!;
  expect(screen.findHostByTestId('fit.plan.work.figure')).not.toBeNull();
  const reading = spokenPlanText(row).join(' ');
  const metricLabel = t('usage.board.plans.planValueTitle');
  expect(reading.startsWith(`${metricLabel}: 2.8×`), reading).toBe(true);
  expect(reading.split('2.8×')).toHaveLength(2);
  expect(reading.indexOf('Account work')).toBeGreaterThan(reading.indexOf('2.8×'));
});

it('reads the compact Plan fit price once before its account caption when precision is hidden', async () => {
  const now = Date.now();
  const amount = 12.12345;
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }], {}, {
    subscription: { status: 'unavailable', renewal: 'unknown', observedAtMs: now, staleAfterMs: HOUR,
      enteredMonthlyPrice: { amount, currency: 'USD', enteredAtMs: now } },
  });
  const { formatUsageCost } = await import('@/utils/format/usageNumbers');
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />);
  const row = screen.findHostByTestId('fit.plan.work')!;
  expect(screen.findHostByTestId('fit.plan.work.figure')).not.toBeNull();
  const value = t('usage.board.plans.planEntered', { amount: formatUsageCost(amount, 'USD') });
  const reading = spokenPlanText(row).join(' ');
  expect(reading.startsWith(`${t('usage.board.plans.planValueTitle')}: ${value}`), reading).toBe(true);
  expect(reading.split(value)).toHaveLength(2);
  expect(reading.indexOf('Account work')).toBeGreaterThan(reading.indexOf(value));
});

it('gives projection series one named exact-values path and keeps repeated figures out of keyboard navigation', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderPlanAccessibility(<UsageProjectionsWidget {...bodyProps([read])} id="usage_projections" testID="proj" />);
  await act(async () => screen.findByTestId('proj.burnUp')!.props.onLayout({ nativeEvent: { layout: { width: 640, height: 150 } } }));
  const toggle = screen.findByTestId('proj.burnUp-values-toggle')!;
  expect(toggle.props.accessibilityLabel).toContain(t('usage.board.charts.showValues'));
  expect(screen.findAllByType(ChartDatum).every(node => node.props.datum.keyboard === false)).toBe(true);
  expect(screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'proj.headline.detail')[0]?.props.focusable).toBe(false);
  await screen.pressByTestIdAsync('proj.burnUp-values-toggle');
  expect(screen.getTextContent()).toContain('60.25');
});

it('exposes all capacity windows through one exact-values disclosure', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 12.345,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderPlanAccessibility(<UsageCapacityWidget {...bodyProps([read])} id="usage_capacity" testID="cap" />);
  const spoken = spokenPlanText(screen.findHostByTestId('cap.capacity')!);
  const remaining = spoken.findIndex(part => part === '70%');
  const caption = spoken.findIndex(part => part === t('usage.board.plans.capacityLoneUnit'));
  const reset = spoken.findIndex(part => part.includes(t('usage.board.plans.capacityResets', { time: formatMoment(now + DAY, now) })));
  expect(remaining).toBeGreaterThanOrEqual(0);
  expect(spoken.slice(0, reset + 1).filter(part => part.includes('70%'))).toEqual(['70%']);
  expect(caption).toBe(remaining + 1);
  expect(reset).toBeGreaterThan(caption);
  expect(screen.findByTestId('cap.values-header')?.props.accessibilityLabel).toContain(t('usage.board.charts.showValues'));
  expect(screen.findAllByType(ChartDatum).every(node => node.props.datum.keyboard === false)).toBe(true);
  expect(screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'cap.tightest-datum')[0]?.props.focusable).toBe(false);
  await screen.pressByTestIdAsync('cap.values-header');
  expect(screen.getTextContent()).toContain('69.88%');
  expect(screen.getTextContent()).toContain('87.66%');
});

it('uses the existing plan details as its named exact-values path', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />);
  expect(screen.findByTestId('fit.plan.work.details-header')?.props.accessibilityLabel).toContain(t('usage.board.charts.showValues'));
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  expect(screen.findAllByType(ChartDatum).every(node => node.props.datum.keyboard === false)).toBe(true);
  expect(screen.findByTestId('fit.plan.work.values.exact')?.props.accessibilityLabel).toContain('60.25%');
});

it('labels unrequested ended PlanFit history as not loaded for multiple accounts', async () => {
  const now = Date.now();
  const reads = ['first', 'second'].map(id => quotaRead(id, now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }], { unusedCapacity: { historyStatus: 'not_loaded', windows: [] } }));
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps(reads)} id="usage_plan_fit" testID="fit-unloaded" />);
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.fitNoneEndedOnce'));
  await screen.pressByTestIdAsync('fit-unloaded.plans-header');
  await screen.pressByTestIdAsync('fit-unloaded.plan.first.details-header');
  expect(screen.getTextContent()).toContain(t('usage.board.plans.pastCyclesNotLoaded'));
});

it('shows unloaded PlanFit history on the visible row beside an unread account', async () => {
  const now = Date.now();
  const history = { historyStatus: 'not_loaded', windows: [] };
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }], { unusedCapacity: history });
  const unread = quotaRead('other', 0, [], { unusedCapacity: history }, { state: 'error_last_known_good', confidence: 'unknown' });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps([read, unread])} id="usage_plan_fit" testID="fit" />);
  expect(screen.findHostByTestId('fit.plan.work.fit.insufficient')).toBeTruthy();
  expect(screen.findByTestId('fit.plan.other')).toBeFalsy();
  expect(screen.getTextContent()).toContain(t('usage.board.plans.pastCyclesNotLoaded'));
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.fitNoneEnded'));
});

it('keeps unloaded PlanFit history visible beside a shared no-ended-windows message', async () => {
  const now = Date.now();
  const weekly = { meterId: 'weekly', label: 'Weekly', usedPct: 30, resetAtMs: now + DAY, windowDurationMs: 7 * DAY };
  const emptyHistory = { historyStatus: 'returned_page', windows: [] };
  const first = quotaRead('first', now, [weekly], { unusedCapacity: emptyHistory });
  const second = quotaRead('second', now, [weekly], { unusedCapacity: emptyHistory });
  const priced = quotaRead('priced', now, [weekly], { unusedCapacity: { historyStatus: 'not_loaded', windows: [] } }, {
    subscription: { status: 'unavailable', renewal: 'unknown', observedAtMs: now, staleAfterMs: HOUR,
      enteredMonthlyPrice: { amount: 20, currency: 'USD', enteredAtMs: now } },
  });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps([first, second, priced])} id="usage_plan_fit" testID="fit" />);

  expect(screen.getTextContent()).toContain(t('usage.board.plans.fitNoneEndedOnce'));
  expect(screen.findHostByTestId('fit.plan.first.fit.insufficient')!.props.children).not.toContain(t('usage.board.plans.fitNoneEnded'));
  expect(screen.findHostByTestId('fit.plan.second.fit.insufficient')!.props.children).not.toContain(t('usage.board.plans.fitNoneEnded'));
  expect(screen.findHostByTestId('fit.plan.priced.fit.insufficient')!.props.children).toContain(t('usage.board.plans.pastCyclesNotLoaded'));
});

it('says once that no plan has anything to compare yet, and keeps every plan one press away (acceptance 11-18 #7)', async () => {
  const now = Date.now();
  const reads = ['first', 'second'].map(id => quotaRead(id, now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]));
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps(reads)} id="usage_plan_fit" testID="fit" />);
  expect(screen.findByTestId('fit.nothingYet')).toBeTruthy();
  expect(screen.findByTestId('fit.plan.first')).toBeFalsy();
  await screen.pressByTestIdAsync('fit.plans-header');
  expect(screen.findByTestId('fit.plan.first')).toBeTruthy();
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.fitNoneEnded'));
});

it('collapses to one line while no plan has a price, even when ended windows were recorded (acceptance 11-21 #3)', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 30, resetAtMs: now + DAY, windowDurationMs: 7 * DAY };
  const reads = ['first', 'second'].map((id) => {
    const base = quotaRead(id, now, [weekly]);
    return ConnectedServiceQuotaGetResultV1Schema.parse({ ...base, unusedCapacity: { historyStatus: 'returned_page', windows: [{
      window: { recordId: base.current!.recordId, meterId: 'weekly', resetAtMs: weekly.resetAtMs - 7 * DAY,
        windowStartAtMs: weekly.resetAtMs - 14 * DAY, windowDurationMs: 7 * DAY },
      value: { status: 'available', unusedAmount: 0, unusedFraction: 0, unit: 'percent', observedAtMs: now - 5 * DAY,
        sampleCount: 5, qualification: 'confirmed', method: 'terminal_observation' },
    }] } });
  });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderPlanAccessibility(<UsagePlanFitWidget {...bodyProps(reads)} id="usage_plan_fit" testID="fit" />);
  expect(screen.getTextContent()).toContain(t('usage.board.plans.planNoPriceAll'));
  expect(screen.findByTestId('fit.plan.first')).toBeFalsy();
  await screen.pressByTestIdAsync('fit.plans-header');
  // The plans' own outcomes stay one press away.
  expect(screen.findByTestId('fit.plan.first.fit')).toBeTruthy();
});

it.each([
  { nowIso: '2026-03-29T12:00:00+02:00', tickIsos: ['2026-03-30T00:00:00+02:00', '2026-03-31T00:00:00+02:00'] },
  { nowIso: '2026-10-25T12:00:00+01:00', tickIsos: ['2026-10-26T00:00:00+01:00', '2026-10-27T00:00:00+01:00'] },
  { nowIso: '2026-08-15T12:00:00+02:00', tickIsos: ['2026-08-16T00:00:00+02:00', '2026-08-17T00:00:00+02:00'] },
])('places Resets ticks at local midnight after $nowIso', async ({ nowIso, tickIsos }) => {
  const now = Date.parse(nowIso);
  const ticks = tickIsos.map(iso => Date.parse(iso));
  const justAfterMidnight = ticks[0]! + 60_000;
  const last = ticks[1]! + HOUR;
  const restore = vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubEnv('TZ', 'Europe/Amsterdam');
  try {
    const read = quotaRead('work', now, [
      { meterId: 'daily', label: 'Daily', usedPct: 25, resetAtMs: justAfterMidnight, windowDurationMs: DAY },
      { meterId: 'weekly', label: 'Weekly', usedPct: 30, resetAtMs: last, windowDurationMs: 7 * DAY },
    ]);
    const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
    const { IntervalTimeline } = await import('@happier-dev/plugin-ui/presentation');
    const screen = await renderPlanAccessibility(
      <WidgetPresentationProvider value={{ size: 'full',
        footprint: { columns: 2, columnSpan: 2, rowSpan: 1, width: 'full', height: 'regular' },
        geometry: { width: 900, height: 320 } }}>
        <UsageResetPlannerWidget {...bodyProps([read])} id="usage_resets" testID="reset" />
      </WidgetPresentationProvider>,
    );
    const timeline = screen.findByType(IntervalTimeline);
    expect(timeline.props.ticks).toEqual(ticks);
    expect(timeline.props.intervals).toEqual(expect.arrayContaining([expect.objectContaining({ start: justAfterMidnight })]));
  } finally {
    restore.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('names reset rows as the exact-values path and includes hidden precision without extra focus targets', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY + 123, windowDurationMs: 7 * DAY }]);
  const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
  const screen = await renderPlanAccessibility(<UsageResetPlannerWidget {...bodyProps([read])} id="usage_resets" testID="reset" />);
  expect(screen.findByTestId('reset.list')?.props.accessibilityLabel).toContain(t('usage.board.charts.showValues'));
  expect(screen.findByTestId('reset.list.0')?.props.accessibilityLabel).toContain('69.88%');
  expect(screen.findAllByType(ChartDatum).every(node => node.props.datum.keyboard === false)).toBe(true);
  expect(screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'reset.list.0.detail')[0]?.props.focusable).toBe(false);
});

it('shows the canonical capacity weather and insufficient model/reset basis inside the existing plan fit body', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const other = quotaRead('other', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 20,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...bodyProps([read, other])} id="usage_plan_fit" testID="fit" />));
  // No plan has a price, an ended window or known terms yet: that is one line, and the plans wait one press away.
  expect(screen.findByTestId('fit.nothingYet')).toBeTruthy();
  await screen.pressByTestIdAsync('fit.plans-header');
  // A plan is one row; its basis lines open under Details.
  expect(screen.findByTestId('fit.plan.work.weather.weekly')).toBeFalsy();
  // An unknown plan value is never a lone dash at the row's far edge, nor repeated on every row.
  expect(screen.getTextContent()).not.toContain('—');
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.planNoPriceShort'));
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  expect(screen.findByTestId('fit.plan.work.weather.weekly')).toBeTruthy();
  // What no account has a basis for yet is one line for the whole widget, never one per account.
  expect(screen.findByTestId('fit.plan.work.insufficient')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.other.insufficient')).toBeFalsy();
  // It is one quiet promise, not a list of internal feature names.
  // No gap here is cured by waiting: the promise is earned only by missing history (see below).
  expect(screen.findByTestId('fit.notRecorded')).toBeFalsy();
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.modelHeadroomTitle'));
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.weekly.insufficient')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.work.pricePerReset.weekly.insufficient')).toBeFalsy();
  expect(screen.findAllByType((await import('@/components/settings/connectedServices/ConnectedServiceMark')).ConnectedServiceMark)
    .find(node => node.props.legacyServiceId === 'claude-subscription')).toBeTruthy();
});

it('draws a plan row only for an account with a reading; a first read in flight is not a placeholder row (Plans #7)', async () => {
  const { createCanonicalJsonSigningInput } = await import('@happier-dev/protocol/crypto/canonicalJson');
  const now = Date.now();
  const props = bodyProps([quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }])]);
  // On a cold load every account is in flight; a row per pending account grew the list and shrank it again as the
  // never-read ones collapsed into their one line.
  const slice = { ...props.slice, sources: [...props.slice.sources, { source: `quota:${createCanonicalJsonSigningInput({
    bindingKind: 'account', ref: { service, accountId: 'spare' } })}`, status: 'pending' as const }] };
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  // The rows are revealed together once every first read has answered: one at a time, a first visit stepped the body
  // down the page ten times (R6 #7: 116 → 567 over 11 s). Until then the body holds one reading placeholder.
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...props} slice={slice} id="usage_plan_fit" testID="fit" />));
  expect(screen.findByTestId('fit.plan.work')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.spare')).toBeFalsy();
  expect(screen.findByTestId('fit.reading')).toBeTruthy();
  await screen.unmount();
  // A re-read of an account that already has a reading is not a first read: its row stays.
  const rereading = { ...props.slice, sources: [...props.slice.sources, { source: `quota:${createCanonicalJsonSigningInput({
    bindingKind: 'account', ref: { service, accountId: 'work' } })}`, status: 'pending' as const }] };
  const settled = await renderScreen(wrap(<UsagePlanFitWidget {...props} slice={rereading} id="usage_plan_fit" testID="fit" />));
  expect(settled.findByTestId('fit.plan.work')).toBeTruthy();
  expect(settled.findByTestId('fit.reading')).toBeFalsy();
});

it('says an empty pace range as one value and one earlier window in the singular (F20)', () => {
  const range = t('usage.board.plans.rangeAtReset', { min: '60%', max: '60%', count: 7 });
  expect(range.split('60%').length - 1).toBe(1);
  expect(t('usage.board.plans.rangeAtReset', { min: '60%', max: '90%', count: 7 })).toContain('90%');
  // The count is pluralised by the locale's helper, not by substituting the number into the plural phrase.
  expect(t('usage.board.plans.earlierShown', { count: 1 })).not.toBe(t('usage.board.plans.earlierShown', { count: 2 }).replace('2', '1'));
});

it('says "no pace yet" only once every first read has answered, and keeps a drawn chart through a re-read (R6 #4)', async () => {
  const { createCanonicalJsonSigningInput } = await import('@happier-dev/protocol/crypto/canonicalJson');
  const now = Date.now();
  // The tightest account has no pace yet; another account's window has one.
  const props = bodyProps([quotaRead('tight', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 90,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }], { pace: [] }), quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly',
    usedPct: 40, resetAtMs: now + DAY, windowDurationMs: 7 * DAY }])]);
  const pendingSource = (accountId: string) => ({ source: `quota:${createCanonicalJsonSigningInput({
    bindingKind: 'account', ref: { service, accountId } })}`, status: 'pending' as const });
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  // Another account's first read is in flight: no pace is chosen yet, and the body says it is reading, not that no
  // window has a pace (the false line drew 150 px, then the chart landed at 578: −424/+406 on a cold Overview).
  const firstRead = await renderScreen(wrap(<UsageProjectionsWidget {...props} id="usage_projections" testID="proj"
    slice={{ ...props.slice, sources: [...props.slice.sources, pendingSource('spare')] }} />));
  expect(firstRead.findByTestId('proj.noPace')).toBeFalsy();
  expect(firstRead.findByTestId('proj.reading')).toBeTruthy();
  await firstRead.unmount();
  // Nor does it chart whichever paced account answered first: the chart moved from window to window as accounts landed.
  const pacedOnly = bodyProps([quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 40,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }])]);
  const provisional = await renderScreen(wrap(<UsageProjectionsWidget {...pacedOnly} id="usage_projections" testID="proj"
    slice={{ ...pacedOnly.slice, sources: [...pacedOnly.slice.sources, pendingSource('spare')] }} />));
  expect(provisional.findByTestId('proj.burnUp')).toBeFalsy();
  expect(provisional.findByTestId('proj.reading')).toBeTruthy();
  await provisional.unmount();
  // An account that has a reading is being read again: its last reading still stands, so the paced chart stays.
  const reread = await renderScreen(wrap(<UsageProjectionsWidget {...props} id="usage_projections" testID="proj"
    slice={{ ...props.slice, sources: [...props.slice.sources, pendingSource('tight')] }} />));
  expect(reread.findByTestId('proj.burnUp')).toBeTruthy();
  expect(reread.findByTestId('proj.noPace')).toBeFalsy();
});

it('shows the entered monthly amount without inventing a provider billing period', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [], {}, { subscription: { status: 'unavailable', renewal: 'unknown',
    observedAtMs: now, staleAfterMs: 60000, enteredMonthlyPrice: { amount: 1.23, currency: 'USD', enteredAtMs: now } } });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />));
  expect(screen.getTextContent()).toContain('$1.23');
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.planNoPriceShort'));
  expect(read.current?.subscription).not.toHaveProperty('currentPeriodStartAtMs');
  await screen.unmount();
});

it('edits the same monthly price draft through mounted commands and the visible fields', async () => {
  const home = mountedHome!.homes.mounted!;
  const now = Date.now();
  const read = quotaRead('work', now, []);
  const { projectUsagePlans } = await import('./usagePlansModel');
  const account = projectUsagePlans([read], now).accounts[0]!;
  const { UsageSubscriptionPriceEditor } = await import('./UsagePlanActions');
  const screen = await renderScreen(wrap(<UsageSubscriptionPriceEditor account={account} serverId={home.id} testID="price" onSettled={() => {}} />));
  await screen.pressByTestIdAsync('price-header');
  await invokePlanCommand(t('usage.board.plans.monthlyPriceAmount'), '24.50');
  await invokePlanCommand(t('usage.board.plans.monthlyPriceCurrency'), 'eur');
  expect(screen.findByTestId('price.amount')!.props.value).toBe('24.50');
  expect(screen.findByTestId('price.currency')!.props.value).toBe('eur');
  await act(async () => screen.findByTestId('price.amount')!.props.onChangeText('30'));
  expect(screen.findByTestId('price.amount')!.props.value).toBe('30');
});

it('opens connected account sign-in from exhausted capacity through mounted and visible commands', async () => {
  const now = Date.now();
  const reading = (usedPct: number) => quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { SETTINGS_ROUTES } = await import('@/components/settings/catalog/routes');
  // The real destination router reaches the native Expo navigation boundary supplied by the testkit.
  const { router } = await import('expo-router');
  vi.mocked(router.push).mockClear();
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...bodyProps([reading(100)])} id="usage_capacity" testID="cap" />));
  expect(screen.findByTestId('cap.nextStep')).toBeTruthy();
  await invokePlanCommand(t('usage.board.plans.capacityAddAccount'));
  expect(router.push).toHaveBeenLastCalledWith(SETTINGS_ROUTES.connectedServicesAgentSignIn);
  vi.mocked(router.push).mockClear();
  await screen.pressByTestIdAsync('cap.nextStep');
  expect(router.push).toHaveBeenLastCalledWith(SETTINGS_ROUTES.connectedServicesAgentSignIn);
  await screen.update(wrap(<UsageCapacityWidget {...bodyProps([reading(40)])} id="usage_capacity" testID="cap" />));
  expect(screen.findByTestId('cap.nextStep')).toBeNull();
  const { executeCurrentUiContextAction } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
  const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
  if (!read.ok) throw new Error(read.errorCode);
  expect(CurrentUiContextSnapshotV1Schema.parse(read.result).commands.some(command => command.title === t('usage.board.plans.capacityAddAccount'))).toBe(false);
});

it('names available model-meter headroom through the catalog and readable unknown fallback', async () => {
  const now = Date.now();
  const base = quotaRead('work', now, [{ meterId: 'known', label: 'Known model', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'external', label: 'External model', usedPct: 40,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({ ...base, current: { ...base.current,
    meters: base.current!.meters.map(meter => ({ ...meter,
      modelId: meter.meterId === 'known' ? 'claude-fable-5' : 'third-party/model-snapshot' })) } });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />));
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.known')).toBeTruthy();
  expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'fit.plan.work.values.detail')?.props.datum.value).toContain('69.88%');
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.external')).toBeTruthy();
  expect(screen.getTextContent()).toContain('Fable 5');
  // An id outside the catalog is shown exactly (2a2cc0979c), never title-cased into a name.
  expect(screen.getTextContent()).toContain('third-party/model-snapshot');
  expect(screen.getTextContent()).not.toContain('claude-fable-5');
});

it('keeps unreported windows reachable behind one count and shows each reset once', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 10,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const unknown = { ...read.current!.meters[0]!, meterId: 'unknown', label: 'Unknown allowance',
    usedPct: null, utilizationPct: null };
  const partial = ConnectedServiceQuotaGetResultV1Schema.parse({ ...read,
    current: { ...read.current, meters: [...read.current!.meters, unknown] } });
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
  const screen = await renderScreen(wrap(<>
    <UsageCapacityWidget {...bodyProps([partial])} id="usage_capacity" testID="cap" />
    <UsageProjectionsWidget {...bodyProps([partial])} id="usage_projections" testID="proj" />
    <UsageResetPlannerWidget {...bodyProps([partial], undefined, normalizeUsageQuery({ session: [] }))} id="usage_resets" testID="reset" />
  </>));
  // A capacity segment is one figure and one plan label (lab ucap/wgusage-CD): its other windows are
  // in its accessible name and in Projections' disclosures, never stacked inline in the bar.
  expect(screen.findByTestId('cap.cell.work.unreported-header')).toBeFalsy();
  expect(screen.findByTestId('cap.cell.work.reported-header')).toBeFalsy();
  expect(String(screen.findByTestId('cap.cell.work')!.props.accessibilityLabel)).toContain('Daily');
  expect(screen.findByTestId('proj.window.work.weekly')).toBeFalsy();
  await screen.pressByTestIdAsync('proj.reported-header');
  expect(screen.findByTestId('proj.window.work.weekly')).toBeTruthy();
  expect(screen.findAllByType((await import('@/components/settings/connectedServices/ConnectedServiceMark')).ConnectedServiceMark)
    .every(node => node.props.legacyServiceId === 'claude-subscription')).toBe(true);
  expect(screen.findByTestId('proj.window.work.unknown')).toBeFalsy();
  await screen.pressByTestIdAsync('proj.unreported-header');
  expect(screen.findByTestId('proj.window.work.unknown')).toBeTruthy();
  expect(screen.findByTestId('reset.list')).toBeTruthy();
  expect(screen.findByTestId('reset.timeline')).toBeFalsy();
  expect(screen.findAllByType(ChartDatum).some(node => String(node.props.testID).startsWith('reset.list.')
    && node.props.datum.value.includes('69.88%'))).toBe(true);
});

it('chooses the earliest settled depletion consistently instead of whichever account answered first', async () => {
  const now = Date.now();
  const later = quotaRead('later', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const earlier = quotaRead('earlier', now, [{ meterId: 'daily', label: 'Daily', usedPct: 90,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const withDepletion = (read: ConnectedServiceQuotaGetResultV1, depletesAtMs: number) => ConnectedServiceQuotaGetResultV1Schema.parse({
    ...read, pace: read.pace.map(row => ({ ...row, value: { ...row.value, depletesAtMs } })),
  });
  const reads = [withDepletion(later, now + 3 * HOUR), withDepletion(earlier, now + HOUR / 2)];
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const render = (quota: readonly ConnectedServiceQuotaGetResultV1[]) => wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps(quota)} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>);
  const screen = await renderScreen(render(reads));
  const aheadText = () => screen.findByTestId('proj.ahead')!.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
  expect(aheadText()).toContain('Account earlier');
  expect(aheadText()).not.toContain('Account later');
  await screen.update(render([...reads].reverse()));
  expect(aheadText()).toContain('Account earlier');
});

it('does not declare all projections missing when a settled paced window is behind Show all', async () => {
  const now = Date.now();
  const stale = quotaRead('stale', now, Array.from({ length: 8 }, (_, index) => ({ meterId: `stale-${index}`,
    label: `Window ${index}`, usedPct: 20, resetAtMs: now + DAY, windowDurationMs: DAY })), { pace: [] });
  const paced = quotaRead('paced', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([stale, paced])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>));
  expect(screen.findByTestId('proj.showAll')).toBeTruthy();
  expect(screen.findByTestId('proj.window.paced.weekly')).toBeFalsy();
  expect(screen.findByTestId('proj.legend')).toBeTruthy();
  // The eight windows without a projection share a cause: said once for the widget, as a partial statement,
  // never as "No projection yet" for the whole list nor beneath every row.
  const text = screen.getTextContent();
  expect(screen.findByTestId('proj.sharedReason')).toBeTruthy();
  expect(text).toContain(t('usage.board.plans.paceSharedReasonSome', { count: 8, reason: t('usage.board.plans.paceNotDerived') }));
  expect(text).not.toContain(t('usage.board.plans.paceSharedReason', { reason: '' }));
});

it.each([false, true])('keeps the first Projections expiry and leaves surviving series alone (expiring window selected: %s)', async selectExpiring => {
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { createCommittedFiberRenderCounter, readTestRendererRoot } = await import('@/dev/testkit/performance/committedFiberCounts');
  const start = Date.UTC(2026, 10, 26, 12);
  vi.useFakeTimers({ now: start, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const reading = (accountId: string, usedPct: number, staleAfterMs: number) =>
      quotaRead(accountId, start, [{ meterId: 'weekly', label: 'Weekly', usedPct,
        resetAtMs: start + DAY, windowDurationMs: 7 * DAY }], {}, { staleAfterMs });
    const first = reading('early', 20, 5 * 60_000);
    const selected = reading('selected', 70, 9 * 60_000);
    const sibling = reading('sibling', 30, 10 * 60_000);
    const counts = createCommittedFiberRenderCounter();
    let readRoot: ReturnType<typeof readTestRendererRoot> | undefined;
    const render = (third: typeof sibling) => wrap(<React.Profiler id="projections"
      onRender={() => { if (readRoot) counts.onCommitRoot(readRoot()); }}>
      <UsageProjectionsWidget {...bodyProps([first, selected, third])} id="usage_projections" testID="proj" />
    </React.Profiler>);
    const screen = await renderScreen(render(sibling));
    readRoot = readTestRendererRoot(screen.tree.root);
    await screen.pressByTestIdAsync('proj.reported-header');
    await screen.update(render(reading('sibling', 31, 11 * 60_000)));
    const selectedControl = (account: string) => screen.findAllByProps({
      testID: `proj.multiple.${account}.weekly`, selected: true,
    }).length > 0;
    expect(screen.findByTestId('proj.multiple.early.weekly')).toBeTruthy();
    if (selectExpiring) await screen.pressByTestIdAsync('proj.multiple.early.weekly');
    expect(selectedControl(selectExpiring ? 'early' : 'selected')).toBe(true);
    expect(screen.findByTestId('proj.window.early.weekly.freshness')).toBeFalsy();
    const survivingSeries = () => screen.findAllByType(BurnUpChart)
      .filter(node => node.props.decorative === true && /Account (selected|sibling)/.test(node.props.label))
      .map(node => node.props.series);
    const before = survivingSeries();
    expect(before).toHaveLength(2);
    const windowComponent = (testID: string) => {
      const instance = screen.findAllByProps({ testID }).find(node => node.props.window?.meterId === 'weekly');
      if (!instance) throw new Error(`Expected a mounted window at ${testID}`);
      return instance.type;
    };
    const row = windowComponent('proj.window.early.weekly');
    const multiple = windowComponent('proj.multiple.sibling.weekly');
    counts.start();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    counts.stop();
    expect(screen.findByTestId('proj.window.early.weekly.freshness')).toBeTruthy();
    expect(screen.getTextContent()).toContain(t('usage.board.plans.paceStale'));
    expect(screen.findByTestId('proj.multiple.early.weekly')).toBeFalsy();
    expect(selectedControl('selected')).toBe(true);
    const measured = counts.read();
    expect(measured.rendersFor(row)).toBe(1);
    expect(measured.rendersFor(UsageProjectionsWidget)).toBe(0);
    const after = survivingSeries();
    expect(after).toHaveLength(before.length);
    after.forEach((series, index) => expect.soft(series).toBe(before[index]));
    expect(measured.rendersFor(multiple)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('Projections samples wall time for the reset on an ordinary layout render', async () => {
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const start = Date.UTC(2026, 10, 26, 12);
  vi.useFakeTimers({ now: start, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const quota = [quotaRead('expired-layout', start - HOUR, [{ meterId: 'weekly', label: 'Weekly', usedPct: 10,
      resetAtMs: start + 2 * 60_000, windowDurationMs: 7 * DAY }], {}, { staleAfterMs: 120_000 })];
    const render = (width: number) => wrap(<WidgetPresentationProvider value={{ size: 'medium',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width, height: 260 } }}>
      <UsageProjectionsWidget {...bodyProps(quota)} id="usage_projections" testID="proj" />
    </WidgetPresentationProvider>);
    const screen = await renderScreen(render(400));
    const freshness = () => screen.findAllByType(SurfaceFreshnessLine)
      .find(node => node.props.testID === 'proj.window.expired-layout.weekly.freshness')?.props.reason;
    expect(freshness()).toContain(t('connectedServicesCollection.meterResetsIn', { time: '2m' }));
    vi.setSystemTime(start + 3 * 60_000);
    await screen.update(render(720));
    expect(freshness()).toContain(t('usage.board.plans.paceStale'));
    expect(freshness()).not.toContain(t('connectedServicesCollection.meterResetsIn', { time: '2m' }));
  } finally {
    vi.useRealTimers();
  }
});

it('only arms metered expiry and moves a used-up count to a retained row at its deadline', async () => {
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { installTimerCensus } = await import('@/dev/testkit/performance/timerCensus');
  const start = Date.UTC(2026, 10, 26, 12);
  vi.useFakeTimers({ now: start, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const census = installTimerCensus(stack => stack.includes('/sessionListRuntimeClock.ts:') ? 'runtime deadline' : null);
  try {
    const spent = quotaRead('spent', start, [{ meterId: 'weekly', label: 'Weekly', usedPct: 100,
      resetAtMs: start + DAY, windowDurationMs: 7 * DAY }], {}, { staleAfterMs: 5 * 60_000 });
    const empty = quotaRead('empty', start, [], {}, { staleAfterMs: 60_000 });
    const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' } }}>
      <UsageProjectionsWidget {...bodyProps([empty, spent])} id="usage_projections" testID="proj" />
    </WidgetPresentationProvider>));
    expect(screen.findByTestId('proj.usedUp')).toBeTruthy();
    expect(screen.findByTestId('proj.window.spent.weekly')).toBeFalsy();
    const runtimeTimers = () => census.read().filter(timer => timer.consumer === 'runtime deadline');
    expect(runtimeTimers()).toEqual([{ kind: 'timeout', delayMs: 5 * 60_000, consumer: 'runtime deadline' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(screen.findByTestId('proj.usedUp')).toBeFalsy();
    expect(screen.findByTestId('proj.window.spent.weekly.freshness')).toBeTruthy();
    expect(runtimeTimers()).toEqual([]);
  } finally {
    census.stop();
    vi.useRealTimers();
  }
});

it('keeps the reported reset when pace has no window and labels a truly expired reading', async () => {
  const now = Date.now();
  const resetAtMs = now + 23 * HOUR + 30_000;
  const read = (accountId: string, usedPct: number, observedAtMs: number, keepDuration: boolean) => {
    const fixture = quotaRead(accountId, observedAtMs, [
      { meterId: 'weekly', label: 'Weekly', usedPct, resetAtMs, windowDurationMs: 7 * DAY },
    ]);
    const snapshot = fixture.current!;
    const current = keepDuration ? snapshot : {
      ...snapshot, meters: snapshot.meters.map(({ windowDurationMs, ...meter }) => meter),
    };
    return projectProviderAccountUsageQuotaReadV1({ input: { source: fixture.source }, current, nowMs: now });
  };
  const expired = read('expired', 60, now - 2 * HOUR, true);
  const resetOnly = read('reset', 30, now, false);
  expect(expired.pace[0]?.value).toMatchObject({ status: 'unavailable', reason: 'stale' });
  expect(resetOnly.pace[0]?.value).toMatchObject({ status: 'unavailable', reason: 'unknown_window' });

  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderPlanAccessibility(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([expired, resetOnly])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>);
  const expiredText = t('usage.board.plans.paceStale');
  expect.soft(screen.getTextContent()).toContain(expiredText);
  expect.soft(screen.findByTestId('proj.window.expired.weekly.freshness')).toBeTruthy();
  expect.soft(screen.findByTestId('proj.usedUp')).toBeFalsy();
  expect.soft(screen.getTextContent()).toContain(t('connectedServicesCollection.meterResetsIn', { time: '' }).trim());
  expect.soft(screen.getTextContent()).not.toContain(t('usage.board.plans.paceUnknownWindow'));
  expect(screen.findAllByType(BurnUpChart)).toHaveLength(0);
  expectProjectionRowReading(screen, 'proj.window.reset.weekly', 'caption', ['Weekly', '70% left', '23h']);
  expectProjectionRowReading(screen, 'proj.window.expired.weekly', 'freshness', [
    'Weekly', '40% left', t('surfaceState.asOf', { time: formatAsOfTime(now - 2 * HOUR, now) }), '23h', expiredText,
  ]);
});

it('counts a used-up window by its value, even when its reading is past the reading horizon (acceptance r230 #75)', async () => {
  const now = Date.now();
  const read = (accountId: string, resetAtMs: number) => {
    const fixture = quotaRead(accountId, now - 2 * 60_000, [
      { meterId: 'weekly', label: 'Weekly', usedPct: 100, resetAtMs, windowDurationMs: 7 * DAY },
    ], {}, { staleAfterMs: 60_000 });
    return projectProviderAccountUsageQuotaReadV1({ input: { source: fixture.source }, current: fixture.current!, nowMs: now });
  };
  const spent = read('spent', now + DAY);
  const renewed = read('renewed', now - HOUR);
  const live = quotaRead('live', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30, resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderPlanAccessibility(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([spent, renewed, live])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>);
  // Nothing comes back before the reset: an older 0% with its reset ahead reads as used up, never as "reading is old",
  // and it keeps its row with the reading's age (J-B57), rather than vanishing into the used-up count.
  expect(screen.findByTestId('proj.window.spent.weekly')).toBeTruthy();
  expect(screen.findByTestId('proj.window.spent.weekly.freshness')).toBeTruthy();
  expectProjectionRowReading(screen, 'proj.window.spent.weekly', 'freshness', [
    'Weekly', '0% left', t('surfaceState.asOf', { time: formatAsOfTime(now - 2 * 60_000, now) }), t('usage.board.plans.cellUsedUp'),
  ]);
  expect(screen.findByTestId('proj.usedUp')).toBeFalsy();
  // Its reset has passed, so the old 0% says nothing about now: it stays listed with its age.
  expect(screen.findByTestId('proj.window.renewed.weekly')).toBeTruthy();
});

it('keeps the old value and reset after a retained comparison expires', async () => {
  const now = Date.now();
  const observedAt = now - 4 * 60_000;
  const resetAtMs = now + DAY;
  const expired = quotaRead('expired', observedAt, [
    { meterId: 'weekly', label: 'Weekly', usedPct: 99, resetAtMs, windowDurationMs: 7 * DAY },
    { meterId: 'rolling', label: 'Rolling', usedPct: 1, resetAtMs, windowDurationMs: DAY },
  ], { pace: [
    { meterId: 'weekly', value: { status: 'unavailable', reason: 'reset_changed' } },
    { meterId: 'rolling', value: { status: 'unavailable', reason: 'entitlement_changed' } },
  ] }, { staleAfterMs: 120_000 });

  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([expired])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>));

  const text = screen.getTextContent();
  expect.soft(text).toContain(t('usage.board.plans.paceStale'));
  expect.soft(text).not.toContain(t('usage.board.plans.paceResetMoved'));
  expect.soft(text).not.toContain(t('usage.board.plans.pacePlanChanged'));
  expect.soft(text).toContain(formatAsOfTime(observedAt, now));
  expect.soft(text).toContain(t('connectedServicesCollection.meterResetsIn', { time: '' }).trim());
  expect.soft(text).toContain('1%');
  expect(text).toContain('99%');
});

it.each([
  ['entitlement_changed', 'usage.board.plans.pacePlanChanged'],
  ['denominator_changed', 'usage.board.plans.paceLimitChanged'],
] as const)('reads a projection row and its countdown once when another row has %s', async (reason, causeKey) => {
  const now = Date.now();
  const base = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + 23 * HOUR + 30_000, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 10,
    resetAtMs: now + 3 * HOUR + 30_000, windowDurationMs: DAY }]);
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({ ...base, pace: base.pace.map(row => row.meterId === 'daily'
    ? { ...row, value: { status: 'unavailable', reason } } : row) });
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageMeterRow } = await import('@/components/settings/connectedServices/usage/UsageMeterRow');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  // A half column of a 1440 sheet: narrower than the shared meter's wide reset column.
  const screen = await renderPlanAccessibility(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 470, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([read])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>);
  const meter = (id: string) => screen.findAllByType(UsageMeterRow).find(node => node.props.testID === `proj.window.work.${id}`)!;
  const projected = read.pace.find(row => row.meterId === 'weekly')!.value;
  if (projected.status !== 'available') throw new Error('Expected available pace');
  expect(meter('weekly').props.resetText).toBe(t('usage.board.plans.projectionAtReset', { percent: `${Math.round(Math.max(0, 1 - projected.projectedResetUtilizationFraction) * 100)}%` }));
  // The column never holds a countdown or a cause.
  expect(meter('daily').props.resetText).toBe('');
  const caption = (id: string) => screen.findByTestId(`proj.window.work.${id}.caption`)!.findAll(node => typeof node.type === 'string')
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
  expect(caption('daily')).toContain(t(causeKey));
  expect(caption('daily')).toContain(t('connectedServicesCollection.meterResetsIn', { time: '' }).trim());
  expect(caption('weekly')).toContain(t('connectedServicesCollection.meterResetsIn', { time: '' }).trim());
  // Too narrow for the projection beside the bar: the row stacks, so its words are never cut.
  expect(meter('weekly').props.layout).toBe('stacked');
  expectProjectionRowReading(screen, 'proj.window.work.daily', 'caption', [
    'Daily', '90% left', '3h', t(causeKey),
  ]);
  expectProjectionRowReading(screen, 'proj.window.work.weekly', 'caption', [
    'Weekly', '70% left', t('usage.board.plans.projectionAtReset', { percent: '40%' }), '23h',
  ]);
});

it.each([
  { state: 'unread', count: 1, observed: false },
  { state: 'mixed', count: 2, observed: true },
])('Projections and Plan fit report $state accounts where each card owns its read state', async ({ count, observed }) => {
  const now = Date.now();
  const reads = Array.from({ length: count }, (_, index) => quotaRead(
    `unread-${index}`, 0, [], {}, { state: 'not_loaded' },
  ));
  if (observed) reads.push(quotaRead('work', now, [{
    meterId: 'weekly', label: 'Weekly', usedPct: 30, resetAtMs: now + DAY, windowDurationMs: 7 * DAY,
  }]));
  const { UsageWidgetBatchProvider } = await import('../usageWidgetBatch');
  const { readUsageWidgetQueryOverrides } = await import('../../usageWidgetPageContext');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const props = bodyProps(reads);
  const widgets = (
    <WidgetPresentationProvider value={{ size: 'medium',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 470, height: 260 } }}>
      <UsageProjectionsWidget {...props} id="usage_projections" testID="proj" />
      <UsagePlanFitWidget {...props} id="usage_plan_fit" testID="fit" />
    </WidgetPresentationProvider>
  );
  for (const onUsagePage of [false, true]) {
    const screen = await renderPlanAccessibility(onUsagePage
      ? <UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(query)} enabled={false}>{widgets}</UsageWidgetBatchProvider>
      : widgets);
    expect(screen.findHostByTestId('proj.window.work.weekly') !== null).toBe(observed);
    expect(screen.findHostByTestId('fit.plan.work') !== null).toBe(observed);
    if (observed) expect(spokenPlanText(screen.findHostByTestId('proj.projections')!).join(' ')).toContain('70% left');
    for (const [bodyId, promise] of [
      ['proj.projections', t('usage.board.plans.projectionsNoneConnected')],
      ['fit.planFit', t('usage.board.plans.planFitNoneConnected')],
    ] as const) {
      const copy = spokenPlanText(screen.findHostByTestId(bodyId)!).join(' ');
      const unread = t('usage.board.plans.capacityNotRead', { count });
      expect.soft(copy.includes(unread), `${bodyId} unread count on ${onUsagePage ? 'Usage' : 'a standalone card'}`).toBe(!onUsagePage);
      expect.soft(copy.includes(promise), `${bodyId} promise on ${onUsagePage ? 'Usage' : 'a standalone card'}`).toBe(onUsagePage && !observed);
    }
  }
});

it('does not materialize curve points for the meter-list presentation', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const props = bodyProps([read]);
  let curveReads = 0;
  const pace = props.slice.quota![0]!.pace[0]!.value;
  if (pace.status !== 'available') throw new Error('Expected available pace');
  for (const point of pace.observedCurve ?? []) {
    const value = point.usedFraction;
    Object.defineProperty(point, 'usedFraction', { get: () => { curveReads += 1; return value; } });
  }
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...props} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>));
  expect(screen.findByTestId('proj.window.work.weekly')).toBeTruthy();
  expect(curveReads).toBe(0);
});

it('lists only live windows beside other widgets; a used-up window is one count, its return said by Limits and Resets (acceptance 11-18 #7)', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 100,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 10,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([read])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>));
  expect(screen.findByTestId('proj.window.work.weekly')).toBeFalsy();
  expect(screen.findByTestId('proj.window.work.daily')).toBeTruthy();
  expect(screen.findByTestId('proj.usedUp')).toBeTruthy();
  expect(screen.getTextContent()).toContain(t('usage.board.plans.projectionsUsedUp', { count: 1 }));
});

it('lists every reported window with its projection beside other widgets, without the burn-up or disclosures', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 10,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const unknown = { ...read.current!.meters[0]!, meterId: 'unknown', label: 'Unknown allowance',
    usedPct: null, utilizationPct: null };
  const partial = ConnectedServiceQuotaGetResultV1Schema.parse({ ...read,
    current: { ...read.current, meters: [...read.current!.meters, unknown] } });
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([partial])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>));
  // Lab wgusage-CD "Limits": the meters are the body, read at a glance.
  expect(screen.findByTestId('proj.window.work.weekly')).toBeTruthy();
  expect(screen.findByTestId('proj.window.work.daily')).toBeTruthy();
  expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'proj.window.work.weekly.datum')?.props.datum.subtitle)
    .toContain(t('usage.board.plans.estimatedFrom', { count: partial.pace[0]!.value.status === 'available' ? partial.pace[0]!.value.sampleCount : 0 }));
  expect(screen.findAllByType(BurnUpChart)).toHaveLength(0);
  expect(screen.findByTestId('proj.reported-header')).toBeFalsy();
  expect(screen.findByTestId('proj.pastCycles-header')).toBeFalsy();
  // Neither window has a pace for the same reason: it is said once under the list, not on each row.
  // Each window has its own projection, so no shared reason is said.
  expect(screen.findByTestId('proj.sharedReason')).toBeFalsy();
  // The unreported window is one quiet count in the list's one footer; its row lives on the Plans view.
  expect(screen.findByTestId('proj.showAll.unlisted')).toBeTruthy();
  expect(screen.findByTestId('proj.window.work.unknown')).toBeFalsy();
  // No window has a pace for the same reason: it is said once under the list, not on each row.
  const unpaced = ConnectedServiceQuotaGetResultV1Schema.parse({ ...partial, pace: [] });
  const quiet = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([unpaced])} id="usage_projections" testID="quiet" />
  </WidgetPresentationProvider>));
  expect(quiet.findByTestId('quiet.sharedReason')).toBeTruthy();
  // No window has a pace: the pace legend explains nothing here, in the list or on the Plans view.
  expect(quiet.findByTestId('quiet.legend')).toBeFalsy();
  // A full-width band among other widgets (Overview) is the same compact list: its burn-up, quota history and past
  // cycles ran ~880 px of near-empty charts there (acceptance 11-13 #1). Only a view of its own (large) charts.
  const band = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'full',
    footprint: { columns: 2, columnSpan: 2, rowSpan: 2, width: 'full', height: 'regular' }, geometry: { width: 1040, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([partial])} id="usage_projections" testID="band" />
  </WidgetPresentationProvider>));
  expect(band.findByTestId('band.windows')).toBeTruthy();
  expect(band.findAllByType(BurnUpChart)).toHaveLength(0);
  expect(band.findByTestId('band.dailyHistory')).toBeFalsy();
  expect(band.findByTestId('band.pastCycles-header')).toBeFalsy();
  const own = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([unpaced])} id="usage_projections" testID="own" />));
  expect(own.findByTestId('own.noPace')).toBeTruthy();
  expect(own.findByTestId('own.reported')).toBeTruthy();
  expect(own.findByTestId('own.legend')).toBeFalsy();
  expect(quiet.getTextContent().split(t('usage.board.plans.paceNotDerived')).length - 1).toBe(1);
});

it('holds no room of its own while first allowance reads are pending: the remembered body height is the one reservation', async () => {
  // A list-sized guess from every known account overshot the remembered height (+168 then −168 on a cold Plans
  // load with memory: four of its accounts never answer). The dispatch's height memory alone holds the room.
  const { QualifiedConnectedServiceUsageSourceV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const sourcesFor = (count: number, status: 'pending' | 'available') => Array.from({ length: count }, (_, index) => ({
    source: `quota:${JSON.stringify(QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
      ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `acct-${index}` } }))}`,
    status,
  }));
  const render = async (count: number, status: 'pending' | 'available', quota?: readonly ConnectedServiceQuotaGetResultV1[]) => {
    const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), sources: sourcesFor(count, status),
      ...(status === 'available' || quota ? { quota: { status: 'available' as const, value: quota ?? [] } } : {}) }, bundledUsageModelPriceCatalog).results[0]!;
    const model = { requestedQuery: null, shownQuery: null, slice, pending: status === 'pending', error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
    return renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
      <UsageProjectionsWidget model={model} slice={slice} query={query} serverId={mountedHome!.homes.mounted!.id} id="usage_projections" testID="proj" />
    </WidgetPresentationProvider>));
  };
  const heldRoom = (screen: Awaited<ReturnType<typeof render>>) => {
    const style = ([] as unknown[]).concat(screen.findByTestId('proj.projections')?.props.style ?? []).flat(2);
    return style.reduce<number>((held, entry) => (entry && typeof entry === 'object' && 'minHeight' in entry ? Number(entry.minHeight) : held), 0);
  };
  expect(heldRoom(await render(5, 'pending'))).toBe(0);
  expect(heldRoom(await render(1, 'pending'))).toBe(0);
  expect(heldRoom(await render(3, 'available'))).toBe(0);
  // One account has answered with a window that has no pace yet while another still reads: no blank line is held
  // for a run-out alert that may come. It dropped at settle (−18 px) under the remembered height.
  const now = Date.now();
  const answered = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30, resetAtMs: now + DAY,
    windowDurationMs: 7 * DAY }], { pace: [] });
  const reading = await render(1, 'pending', [answered]);
  expect(reading.findByTestId('proj.window.work.weekly')).toBeTruthy();
  expect(reading.findByTestId('proj.aheadRoom')).toBeFalsy();
  expect(heldRoom(reading)).toBe(0);
});

it('shows attributed API-equivalent account value and a qualified price multiple without claiming paid savings', async () => {
  const now = Date.now();
  const shownQuery = normalizeUsageQuery({ period: { startMs: now - DAY, endMs: now + DAY } });
  const read = quotaRead('work', now, [], {}, { subscription: {
    status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: HOUR,
    currentPeriodStartAtMs: now - DAY, currentPeriodEndAtMs: now + DAY,
    enteredMonthlyPrice: { amount: 2, currency: 'USD', enteredAtMs: now - DAY },
  } });
  const base = bodyProps([read], undefined, shownQuery);
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const slice = resolveUsagePageAggregation({ queries: [shownQuery], nowMs: now,
    quota: { status: 'available', value: [read] }, pricingOverrides: { model: { kind: 'rates', inputUsdPerMillion: 4, outputUsdPerMillion: 1 } },
    accounting: [{ query: shownQuery, status: 'available', value: { v: 1,
      totals: { eventCount: 1, tokens, cost: { reportedUsd: 20, estimatedUsd: 8, currency: 'USD' } },
      contributions: [{ id: 'account-value', eventCount: 1, observedAtMs: now - 1, sessionId: 's', turnId: 't', agentId: 'agent',
        modelId: 'model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens,
        cost: { reportedUsd: 20, estimatedUsd: 8, currency: 'USD' }, providerAttribution: 'known', connectedAccount: read.source.ref }],
    } }],
  }, bundledUsageModelPriceCatalog).results[0]!;
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...base} slice={slice} id="usage_plan_fit" testID="fit" />));
  // The row's one key figure is the qualified multiple ($4.00 observed against the $2.00 entered price).
  expect(screen.getTextContent()).toContain('2×');
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  const value = screen.findHostByTestId('fit.plan.work.value');
  expect(value).toBeTruthy();
  expect(value!.props.accessibilityLabel).toContain('$4.00');
  expect(value!.props.accessibilityLabel).toContain('2');
  expect(value!.props.accessibilityLabel).toContain('API-equivalent');
  expect(value!.props.accessibilityLabel).not.toContain('$20.00');
  expect(value!.props.accessibilityLabel).not.toContain('saved');
});

it('refreshes the mounted plan price and ending when the quota reading stays the same', async () => {
  const now = Date.now();
  const quotaObservedAtMs = now - HOUR / 2;
  const meters = [{ meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + DAY, windowDurationMs: 7 * DAY }];
  const startAtMs = now - DAY;
  const oldEnd = now + 10 * DAY;
  const newEnd = now + 17 * DAY;
  const reading = (renewal: 'on' | 'off', amount: number, observedAtMs: number, endAtMs: number) => quotaRead('work', quotaObservedAtMs, meters, {}, {
    subscription: { status: 'subscribed', renewal, observedAtMs, staleAfterMs: HOUR,
      currentPeriodStartAtMs: startAtMs, currentPeriodEndAtMs: endAtMs,
      monetaryFacts: [{ kind: 'paid', amount, currency: 'USD', period: { startAtMs, endAtMs },
        source: { kind: 'provider', id: 'provider-invoice', version: '1' }, effectiveAtMs: observedAtMs, asOfMs: observedAtMs }],
    },
  });
  const before = bodyProps([reading('on', 20, now - HOUR / 3, oldEnd)]);
  const after = bodyProps([reading('off', 35, now - HOUR / 6, newEnd)], undefined, query, { v: 1, results: [before.slice] });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const widget = (props: ReturnType<typeof bodyProps>) => wrap(<UsagePlanFitWidget {...props} id="usage_plan_fit" testID="fit" />);
  const screen = await renderScreen(widget(before));
  const oldMoney = formatUsageCost(20, 'USD');
  const newMoney = formatUsageCost(35, 'USD');
  const renewal = t('usage.board.plans.planRenews', { time: formatMoment(oldEnd, now) });
  const ending = t('usage.board.plans.planEnds', { time: formatMoment(newEnd, now) });
  const rowLabel = () => spokenPlanText(screen.findHostByTestId('fit.plan.work')!).join(' ');
  expect(rowLabel()).toContain(oldMoney);
  expect(rowLabel()).toContain(renewal);

  await screen.update(widget(after));
  expect(rowLabel()).toContain(newMoney);
  expect(rowLabel()).toContain(ending);
  expect(rowLabel()).not.toContain(oldMoney);
  expect(rowLabel()).not.toContain(renewal);
});

it('shows a recorded week from accounting even without connected plan accounts', async () => {
  const startMs = Date.UTC(2026, 8, 28);
  const endMs = Date.UTC(2026, 9, 5);
  const shownQuery = normalizeUsageQuery({ period: { startMs, endMs } });
  const base = bodyProps([], undefined, shownQuery);
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const slice = resolveUsagePageAggregation({ queries: [shownQuery], nowMs: endMs,
    accounting: [{ query: shownQuery, status: 'available', value: { v: 1,
      totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
      activity: { calendarDays: [{ date: '2026-10-01', eventCount: 1 }], weekdayHourBuckets: [] },
    } }] }, bundledUsageModelPriceCatalog).results[0]!;
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...base} slice={slice} id="usage_plan_fit" testID="fit" />));
  expect(screen.findByTestId('fit.recordedWeek')).toBeTruthy();
});

it('keeps the recorded week and the pace target beside the one "nothing yet" line (review E-03)', async () => {
  const startMs = Date.UTC(2026, 8, 28);
  const endMs = Date.UTC(2026, 9, 5);
  const shownQuery = normalizeUsageQuery({ period: { startMs, endMs } });
  const reads = ['first', 'second'].map(id => quotaRead(id, endMs, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: endMs + DAY, windowDurationMs: 7 * DAY }]));
  const base = bodyProps(reads, undefined, shownQuery);
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const slice = resolveUsagePageAggregation({ queries: [shownQuery], nowMs: endMs, quota: { status: 'available', value: reads },
    accounting: [{ query: shownQuery, status: 'available', value: { v: 1,
      totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
      activity: { calendarDays: [{ date: '2026-10-01', eventCount: 1 }], weekdayHourBuckets: [] },
    } }] }, bundledUsageModelPriceCatalog).results[0]!;
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...base} slice={slice} id="usage_plan_fit" testID="fit" />));
  expect(screen.findByTestId('fit.nothingYet')).toBeTruthy();
  expect(screen.findByTestId('fit.recordedWeek')).toBeTruthy();
  expect(screen.findByTestId('fit.paceTarget')).toBeTruthy();
});

it("lists a pool in the selector's own order and builds the why detail from its trace only when opened", async () => {
  const now = Date.now();
  const weekly = (usedPct: number): Meter => ({
    meterId: 'weekly',
    label: 'Weekly',
    usedPct,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  });
  const quota = [
    quotaRead('personal', now, [weekly(10)]),
    quotaRead('work', now, [weekly(30)]),
    quotaRead('side', now, [weekly(100)]),
  ];
  const group = { service, groupId: 'pool' };
  const candidate = (profileId: string, priority: number) => ({
    profileId,
    priority,
    createdAtMs: 1,
    enabled: true,
    leastLimitedScore: 62,
    preferenceDeadlineMs: now + 2 * DAY,
  });
  const selection = {
    selected: candidate('work', 0),
    reason: 'selected' as const,
    excluded: [
      {
        profileId: 'side',
        reason: 'quota_exhausted' as const,
        retryAtMs: now + 3 * HOUR,
      },
    ],
    decisionTrace: {
      activeProfileId: 'personal',
      reason: 'selected' as const,
      strategy: 'expiry_first' as const,
      selectionBasis: 'preference' as const,
      sticky: false,
      orderedEligibleCandidates: [
        candidate('work', 0),
        candidate('personal', 1),
      ],
      candidates: [
        {
          profileId: 'work',
          decision: 'selected' as const,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 62,
            capturedAtMs: now - 120_000,
          },
        },
        {
          profileId: 'personal',
          decision: 'eligible' as const,
          quotaEvidence: { status: 'stale_or_missing' as const },
        },
        {
          profileId: 'side',
          decision: 'excluded' as const,
          exclusionReason: 'quota_exhausted' as const,
          retryAtMs: now + 3 * HOUR,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 0,
            capturedAtMs: now - 120_000,
            exhausted: true,
          },
        },
      ],
    },
  };
  const props = bodyProps(quota, [
    {
      query,
      value: [
        {
          group,
          memberAccountIds: ['work', 'personal', 'side'],
          activeAccountId: 'personal',
          selection: {
            status: 'available',
            machineId: 'witnessed-selector',
            value: { group, observedAtMs: now, activeAccountRef: { service, accountId: 'personal' }, selection },
          },
        },
      ],
    },
  ]);
  const comparisonProfile = AccountProfileSchema.parse({ ...storage.getState().profile, id: 'comparison-account' });
  let comparisonUnavailable = false;
  comparisonHome = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-pool-comparison.test', accountId: 'comparison-account', profile: comparisonProfile }],
    route: request => request.path === '/test/selection' ? new Response(null, { status: comparisonUnavailable ? 503 : 200 })
      : request.path === '/v1/account/encryption/currentness'
        ? Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined });
  const home = comparisonHome.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: home.id, accountId: 'comparison-account' }, profile: comparisonProfile });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!;
  selectionTransport.mockImplementation(async (request: { payload: unknown }) => {
    const response = await comparisonHome!.fetch('https://usage-pool-comparison.test/test/selection');
    if (!response.ok) throw new RetryableServerResponseError(response.status, 'unavailable');
    const input = ConnectedServicePoolSelectionGetRequestV1Schema.parse(request.payload);
    expect(input.machineId).toBe('witnessed-selector');
    expect(input.group).toEqual(group);
    const hypothetical = { strategy: input.hypothetical!.strategy!, atMs: input.hypothetical!.atMs! };
    return { group, observedAtMs: now, hypothetical, selection: { ...selection, selected: candidate('work', 0),
      decisionTrace: { ...selection.decisionTrace, strategy: hypothetical.strategy, selectionBasis: 'preference', sticky: false,
        orderedEligibleCandidates: [candidate('work', 0), candidate('personal', 1)],
        candidates: selection.decisionTrace.candidates.map(entry => ({ ...entry,
          decision: entry.profileId === 'work' ? 'selected' : entry.profileId === 'personal' ? 'eligible' : 'excluded' })) } } };
  });
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...props} serverId={home.id} id="usage_capacity" testID="cap" /></InjectedAuthProvider>,
  );
  const queue = ['personal', 'work', 'side'].map((id) =>
    screen.findHostByTestId(`cap.usedFirst.pool.${id}`),
  );
  expect(queue.every(Boolean)).toBe(true);
  expect(queue[0]!.props.accessibilityLabel).toContain(t('usage.board.plans.usedFirstInUse'));
  expect(queue[1]!.props.accessibilityLabel).not.toContain(t('usage.board.plans.usedFirstInUse'));
  expect(queue[1]!.props.accessibilityLabel).toContain(t('usage.board.plans.basisPreference'));
  expect(queue[0]!.props.accessibilityLabel).not.toContain(t('usage.board.plans.basisPreference'));
  // The Account's own read order is personal, work: the queue follows the selector's order instead.
  const order = screen
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        /^cap\.usedFirst\.pool\.(work|personal|side)$/.test(
          node.props.testID,
        ) &&
        typeof node.type === 'string',
    )
    .map((node) => node.props.testID as string);
  expect([...new Set(order)]).toEqual([
    'cap.usedFirst.pool.work',
    'cap.usedFirst.pool.personal',
    'cap.usedFirst.pool.side',
  ]);
  expect(screen.getTextContent()).toContain('Expiring first');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeNull();
  expect(screen.getTextContent()).not.toContain('62%');
  await invokePlanCommand(t('usage.board.plans.whyTitle'));
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeTruthy();
  expect(screen.findByTestId('cap.usedFirst.pool.why.comparison.strategy')).toBeTruthy();
  expect(screen.findByTestId('cap.usedFirst.pool.why.comparison.moment')).toBeTruthy();
  expect(
    screen.findByTestId('cap.usedFirst.pool.why.candidate.work'),
  ).toBeTruthy();
  // The evidence is the trace's own number (62), not the meter's (70% left).
  expect(screen.getTextContent()).toContain('62%');
  expect(
    screen.findHostByTestId('cap.usedFirst.pool.why.candidate.side')!.props
      .accessibilityLabel,
  ).toContain('used up');
  const comparison = 'cap.usedFirst.pool.why.comparison';
  const strategyControl = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${comparison}.strategy`)!;
  await invokePlanCommand(t('usage.board.plans.whyRule'));
  expect(strategyControl.props.open).toBe(true);
  await invokePlanCommand(getPoolStrategyPresentation('priority').label);
  await expect.poll(() => screen.findHostByTestId(`${comparison}.candidate.work`) !== null).toBe(true);
  const momentControl = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${comparison}.moment`)!;
  await act(async () => momentControl.props.onOpenChange(true));
  await invokePlanCommand(formatMoment(now + 3 * HOUR, now));
  await expect.poll(() => selectionTransport.mock.calls.some(([request]) => request.payload.hypothetical.atMs === now + 3 * HOUR)).toBe(true);
  const comparisonOrder = screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
    && new RegExp(`^${comparison.replaceAll('.', '\\.')}.candidate.(work|personal|side)$`).test(node.props.testID))
    .map(node => node.props.testID);
  expect([...new Set(comparisonOrder)]).toEqual([`${comparison}.candidate.work`, `${comparison}.candidate.personal`, `${comparison}.candidate.side`]);
  // Hypothetical rows never replace the current queue or issue a mutation Action.
  expect(screen.findHostByTestId('cap.usedFirst.pool.personal')).toBeTruthy();
  expect(comparisonHome.requests.filter(request => request.method === 'POST' && request.path.startsWith('/v1/artifacts'))).toEqual([]);
  const captured = captureUiUsageQueryAccountContext(credentials)!;
  const comparisonEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'connectedServices.pools.selection.get',
    input: { machineId: 'witnessed-selector', group, hypothetical: { strategy: 'priority', atMs: now + 3 * HOUR } } });
  comparisonUnavailable = true;
  await act(async () => { await comparisonEntry.refresh(); });
  expect.soft(screen.findHostByTestId(`${comparison}.candidate.work`), 'a failed replacement keeps the admitted comparison').toBeTruthy();
  expect.soft(screen.getTextContent()).toContain(t('usage.board.plans.usedFirstReadFailed'));
  const beforeRetry = storage.getState().settings.actionsSettingsV1;
  await act(async () => { storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
    v: 1, actions: { ...beforeRetry.actions, 'connectedServices.pools.selection.get': { disabledSurfaces: ['agent'] } },
  }) } })); });
  await invokePlanCommand(t('common.retry'), undefined, { ok: false, errorCode: 'action_disabled' });
  await act(async () => { storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: beforeRetry } })); });
  const { createCanonicalJsonSigningInput } = await import('@happier-dev/protocol/crypto/canonicalJson');
  const failedQuotaSource = `quota:${createCanonicalJsonSigningInput(quota[0]!.source)}`;
  const retryQuota = vi.fn(async () => {});
  const failedQuotaSlice = { ...props.slice, sources: [...props.slice.sources.filter(source => source.source !== failedQuotaSource),
    { source: failedQuotaSource, status: 'stale' as const, errorCode: 'provider_account_usage_read_failed', asOfMs: now }] };
  await screen.update(<InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...props} slice={failedQuotaSlice}
    model={{ ...props.model, refresh: retryQuota }} serverId={home.id} id="usage_capacity" testID="cap" /></InjectedAuthProvider>);
  const retryControls = () => screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === t('common.retry'));
  expect(retryControls().map(node => node.props.testID).sort()).toEqual(['cap.state-action', `${comparison}.failed-action`]);
  expect(screen.findAllByType(SurfaceFreshnessLine).find(node => node.props.testID === 'cap.state')?.props)
    .toMatchObject({ tone: 'warning', asOf: now });
  await screen.pressByTestIdAsync('cap.state-action');
  expect(retryQuota).toHaveBeenCalledTimes(1);
  comparisonUnavailable = false;
  await screen.pressByTestIdAsync(`${comparison}.failed-action`);
  expect(retryQuota).toHaveBeenCalledTimes(1);
  expect(retryControls().map(node => node.props.testID)).toEqual(['cap.state-action']);
  expect(screen.findHostByTestId(`${comparison}.candidate.work`)).toBeTruthy();
  await invokePlanCommand(`${t('usage.board.plans.whyTitle')}: ${t('common.close')}`);
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeNull();
  await screen.pressByTestIdAsync('cap.usedFirst.pool.why');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeTruthy();
  const failed = bodyProps(quota, [{ query, value: [{ group, memberAccountIds: ['work', 'personal', 'side'],
    activeAccountId: 'personal', selection: { status: 'error', machineId: 'witnessed-selector', errorCode: 'connected_service_request_failed' } }] }], query,
    { v: 1, results: [props.slice] });
  await screen.update(<InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...failed} serverId={home.id}
    id="usage_capacity" testID="cap" /></InjectedAuthProvider>);
  expect.soft(screen.findHostByTestId('cap.usedFirst.pool.personal')).toBeTruthy();
  expect.soft(screen.getTextContent()).toContain(t('usage.board.plans.usedFirstReadFailed'));
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.hintLoading'));
  const refused = new Set(quota.map(read => `quota:${createCanonicalJsonSigningInput(read.source)}`));
  const ownershipRefused = {
    ...props.slice,
    quota: undefined,
    sources: [...props.slice.sources.filter(source => !refused.has(source.source)),
      ...Array.from(refused, source => ({ source, status: 'error' as const, errorCode: 'ownership_unproven' }))],
  };
  await screen.update(<InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...props}
    slice={ownershipRefused} serverId={home.id} id="usage_capacity" testID="cap" /></InjectedAuthProvider>);
  expect(screen.findByTestId('cap.state.heldBack')).toBeTruthy();
  expect(screen.findByTestId('cap.usedFirst')).toBeNull();
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeNull();
  await screen.update(<InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...props}
    serverId={home.id} id="usage_capacity" testID="cap" /></InjectedAuthProvider>);
  expect(screen.findByTestId('cap.usedFirst.pool.work')).toBeTruthy();
});

it('gives a pool the selector lists no member for one quiet line, not a strategy block', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY };
  const group = { service, groupId: 'empty' };
  const selection = { selected: null, reason: 'no_eligible_members' as const, excluded: [],
    decisionTrace: { activeProfileId: null, reason: 'no_eligible_members' as const, strategy: 'expiry_first' as const,
      selectionBasis: 'no_eligible_members' as const, sticky: false, orderedEligibleCandidates: [], candidates: [] } };
  const props = bodyProps(['a', 'b'].map((id) => quotaRead(id, now, [weekly])), [{ query, value: [{ group,
    memberAccountIds: ['a', 'b'], activeAccountId: null,
    selection: { status: 'available', machineId: 'witnessed-selector', value: { group, observedAtMs: now, selection } } }] }]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...props} id="usage_capacity" testID="cap" />));
  expect(screen.findHostByTestId('cap.usedFirst.empty')).toBeTruthy();
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.whyNone'));
  expect(screen.findByTestId('cap.usedFirst.empty.why')).toBeNull();
  expect(screen.getTextContent()).not.toContain('Expiring first');
  await screen.update(wrap(<WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
    <UsageCapacityWidget {...props} id="usage_capacity" testID="cap" />
  </WidgetPresentationProvider>));
  expect(screen.getTextContent()).toContain('empty');
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.whyNone'));
  const excluded = bodyProps(['a', 'b'].map(id => quotaRead(id, now, [weekly])), [{ query, value: [{ group,
    memberAccountIds: ['a', 'b'], activeAccountId: null, selection: { status: 'available', machineId: 'witnessed-selector',
      value: { group, observedAtMs: now, selection: { ...selection, excluded: ['a', 'b'].map(profileId => ({ profileId, reason: 'disabled' as const })) } } } }] }]);
  await screen.update(wrap(<UsageCapacityWidget {...excluded} id="usage_capacity" testID="cap" />));
  await screen.pressByTestIdAsync('cap.usedFirst.empty.why');
  expect(screen.getTextContent()).toContain(t('usage.board.plans.whyNone'));
});

it('shows the known retry from the selector for a wholly used-up pool and keeps its order to one line', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 100, resetAtMs: now + 4 * DAY, windowDurationMs: 7 * DAY };
  const group = { service, groupId: 'spent' };
  const selection: ConnectedServicePoolSelectionV1 = { selected: null, reason: 'no_eligible_members',
    excluded: [{ profileId: 'a', reason: 'quota_exhausted', retryAtMs: now + 2 * DAY },
      { profileId: 'b', reason: 'quota_exhausted', retryAtMs: now + DAY }],
    decisionTrace: { activeProfileId: null, reason: 'no_eligible_members', strategy: 'expiry_first',
      selectionBasis: 'no_eligible_members', sticky: false, orderedEligibleCandidates: [],
      candidates: ['a', 'b'].map(profileId => ({
        profileId, decision: 'excluded', exclusionReason: 'quota_exhausted', quotaEvidence: { status: 'fresh', exhausted: true },
      })) } };
  const accountLabel = 'Work account';
  const reads = [
    quotaRead('a', now, [weekly], {}, { accountLabel }),
    quotaRead('b', now, [weekly], {}, { accountLabel: 'Personal account' }),
  ];
  const nextQuotaRetry = { profileId: 'a', retryAtMs: now + 3 * DAY };
  const propsFor = (poolSelection: ConnectedServicePoolSelectionV1) => bodyProps(reads, [{ query, value: [{
    group, memberAccountIds: ['a', 'b'], activeAccountId: null,
    selection: { status: 'available', machineId: 'witnessed-selector', value: { group, observedAtMs: now, selection: poolSelection } },
  }] }]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...propsFor({ ...selection, nextQuotaRetry })} id="usage_capacity" testID="cap" />));
  const headline = screen.findHostByTestId('cap.firstBack');
  const headlineText = headline?.findAllByType('Text').flatMap(collectNodeText).join(' ');
  expect.soft(headlineText).toContain(accountLabel);
  const time = formatMoment(nextQuotaRetry.retryAtMs, now).replace(/\s/g, ' ');
  expect.soft(headlineText?.replace(/\s/g, ' ')).toContain(time);
  const spoken = spokenPlanText(headline!).map(part => part.replace(/\s/g, ' '));
  expect(spoken.slice(0, 2)).toEqual([time, t('usage.board.plans.capacityNextKnownRetry', { account: accountLabel })]);
  expect(spoken.filter(part => part.includes(time))).toEqual([time]);
  expect(screen.findByTestId('cap.tightest')).toBeFalsy();
  expect(screen.findByTestId('cap.usedFirst.spent.allUsedUp')).toBeTruthy();
  expect(screen.findByTestId('cap.usedFirst.spent.a')).toBeFalsy();

  await screen.update(wrap(<UsageCapacityWidget {...propsFor(selection)} id="usage_capacity" testID="cap" />));
  expect.soft(screen.findByTestId('cap.firstBack')).toBeNull();
  expect(screen.findHostByTestId('cap.tightest')?.props.accessibilityLabel).toContain('0%');
});

it('gives each Limits pool its own exhausted tone and distinguishes low and healthy quota', async () => {
  const now = Date.now();
  const weekly = (usedPct: number): Meter => ({
    meterId: 'weekly', label: 'Weekly', usedPct, resetAtMs: now + DAY, windowDurationMs: 7 * DAY,
  });
  const spentPool = (groupId: string, spent: string, spare: string) => {
    const group = { service, groupId };
    const memberAccountIds = [spent, spare];
    const selection: ConnectedServicePoolSelectionV1 = {
      selected: null, reason: 'no_eligible_members',
      nextQuotaRetry: { profileId: spent, retryAtMs: now + DAY },
      excluded: memberAccountIds.map(profileId => ({ profileId, reason: 'quota_exhausted', retryAtMs: now + DAY })),
      decisionTrace: { activeProfileId: null, reason: 'no_eligible_members', strategy: 'expiry_first',
        selectionBasis: 'no_eligible_members', sticky: false, orderedEligibleCandidates: [],
        candidates: memberAccountIds.map(profileId => ({
          profileId, decision: 'excluded', exclusionReason: 'quota_exhausted', quotaEvidence: { status: 'fresh', exhausted: true },
        })),
      },
    };
    return { group, memberAccountIds, activeAccountId: null,
      selection: { status: 'available' as const, machineId: 'witnessed-selector', value: { group, observedAtMs: now, selection } } };
  };
  const routed = spentPool('routed', 'skipped', 'low');
  const low = { profileId: 'low', priority: 0, createdAtMs: 1, enabled: true, leastLimitedScore: 5, preferenceDeadlineMs: now + DAY };
  const routedSelection: ConnectedServicePoolSelectionV1 = {
    selected: low, reason: 'selected', excluded: routed.selection.value.selection.excluded.slice(0, 1),
    decisionTrace: { ...routed.selection.value.selection.decisionTrace, reason: 'selected', selectionBasis: 'preference',
      orderedEligibleCandidates: [low], candidates: [routed.selection.value.selection.decisionTrace.candidates[0]!,
        { profileId: 'low', decision: 'selected', quotaEvidence: { status: 'fresh', exhausted: false, remainingPercent: 5 } }],
    },
  };
  const props = bodyProps([
    ...['spent-a', 'spent-b', 'skipped', 'waiting'].map(id => quotaRead(id, now, [weekly(100)])),
    quotaRead('low', now, [weekly(95)]),
    quotaRead('healthy', now, [weekly(20)]),
    quotaRead('unread', 0, [], {}, { state: 'not_loaded' }),
  ], [{ query, value: [
    spentPool('spent', 'spent-a', 'spent-b'),
    { ...routed, selection: { ...routed.selection, value: { ...routed.selection.value, selection: routedSelection } } },
    spentPool('unknown', 'waiting', 'unread'),
  ] }]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { HappierProgress } = await import('@happier-dev/plugin-ui/presentation');
  const { lightTheme } = await import('@/theme');
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...props} id="usage_capacity" testID="cap" />));
  for (const [id, tone] of [
    ['spent-a', 'warning'], ['spent-b', 'warning'], ['skipped', 'neutral'], ['low', 'warning'],
    ['healthy', 'neutral'], ['waiting', 'neutral'],
  ] as const) {
    const cell = screen.findHostByTestId(`cap.cell.${id}`);
    expect.soft(cell?.findAllByType(HappierProgress).map(bar => bar.props.fillColor), id).toEqual([lightTheme.colors.state[tone].foreground]);
  }
  expect(screen.findHostByTestId('cap.cell.unread')).toBeNull();
});

it('states one unreadable-order cause once under every pool that shares it (H30)', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY };
  const pool = (groupId: string, memberAccountIds: string[]) => ({
    group: { service, groupId }, memberAccountIds, activeAccountId: memberAccountIds[0]!,
    selection: { status: 'unsupported' as const, errorCode: 'no_machine' as const },
  });
  const props = bodyProps(['a', 'b', 'c', 'd'].map((id) => quotaRead(id, now, [weekly])),
    [{ query, value: [pool('first', ['a', 'b']), pool('second', ['c', 'd'])] }]);
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...props} id="usage_capacity" testID="cap" />));
  const cause = t('usage.board.plans.usedFirstNoMachine');
  expect(screen.getTextContent().split(cause).length - 1).toBe(1);
  expect(screen.findHostByTestId('cap.usedFirst.cause')).toBeTruthy();
  expect(screen.findHostByTestId('cap.usedFirst.first')).toBeTruthy();
  expect(screen.findHostByTestId('cap.usedFirst.second')).toBeTruthy();
  // Pools with no order to show share one quiet "Used first" label over their names, not a heading each.
  expect(screen.getTextContent().split(t('usage.board.plans.queueTitle')).length - 1).toBe(1);
  expect(screen.getTextContent()).not.toContain(`${t('usage.board.plans.queueTitle')} ·`);
});

it('greets an Account with nothing connected with the shared empty state, its connect scene and the one sign-in (58d AF1)', async () => {
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  // Nothing connected: the quota read settles with no account, and a history page marker can still be partial.
  const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), quota: { status: 'partial', value: [] } }, bundledUsageModelPriceCatalog).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
    refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(wrap(<UsageCapacityWidget model={model} slice={slice} query={query} serverId={mountedHome!.homes.mounted!.id} id="usage_capacity" testID="cap" />));
  const states = screen.findAllByType(SurfaceStateCard);
  expect(states).toHaveLength(1);
  // The widget empty state every frame uses (centred, replacing the body), not an inline line beside a link.
  // It invites the sign-in, and one line says what will appear here (owner 10-31 first-run rules).
  expect(states[0]!.props).toMatchObject({ kind: 'empty', replacesContent: true, scene: 'connectAccount',
    title: t('usage.board.plans.capacitySignInTitle'), reason: t('usage.board.plans.capacityNoneConnectedPromise') });
  // Capacity's empty state carries the sign-in; Get set up drops its item while Capacity is placed.
  expect(states[0]!.props.action).toMatchObject({ label: t('usage.board.plans.capacitySignIn') });
  expect(states[0]!.props.layout).toBeUndefined();
  expect(states[0]!.props.size).toBeUndefined();
  expect(screen.findHostByTestId('cap.none.coverage')).toBeNull();
});

it.each([
  { caseName: 'on its own', sibling: null },
  { caseName: 'beside a measured plan', sibling: 'measured' },
  { caseName: 'while another account is still reading', sibling: 'pending' },
])('ownership unproven names the connected account and its reason in Capacity and Plan Fit $caseName', async ({ sibling }) => {
  const { createCanonicalJsonSigningInput } = await import('@happier-dev/protocol/crypto/canonicalJson');
  const now = Date.now();
  const accountId = 'team-work';
  const source = { bindingKind: 'account', ref: { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId } };
  const amount = 23;
  const healthy = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 20,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }], {}, {
    subscription: { status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: HOUR,
      currentPeriodStartAtMs: now - DAY, currentPeriodEndAtMs: now + 10 * DAY,
      monetaryFacts: [{ kind: 'paid', amount, currency: 'USD', period: { startAtMs: now - DAY, endAtMs: now + 10 * DAY },
        source: { kind: 'provider', id: 'provider-invoice', version: '1' }, effectiveAtMs: now, asOfMs: now }],
    },
  });
  const refusal = { source: `quota:${createCanonicalJsonSigningInput(source)}`, status: 'error' as const, errorCode: 'ownership_unproven' };
  const pending = { source: `quota:${createCanonicalJsonSigningInput(healthy.source)}`, status: 'pending' as const };
  const sliceFor = (quota: Parameters<typeof resolveUsagePageAggregation>[0]['quota']) =>
    resolveUsagePageAggregation({ queries: [query], nowMs: now, quota }, bundledUsageModelPriceCatalog).results[0]!;
  const slice = sliceFor({
    status: sibling === 'measured' ? 'partial' : sibling === 'pending' ? 'pending' : 'error',
    ...(sibling === 'measured' ? { value: [healthy] } : {}),
    sources: sibling === 'pending' ? [refusal, pending] : [refusal],
  });
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const widgets = (slice: ReturnType<typeof sliceFor>) => {
    const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
      refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
    const body = { model, slice, query, serverId: mountedHome!.homes.mounted!.id };
    return wrap(<>
      <UsageCapacityWidget {...body} id="usage_capacity" testID="cap" />
      <UsagePlanFitWidget {...body} id="usage_plan_fit" testID="fit" />
    </>);
  };
  const screen = await renderScreen(widgets(slice));

  // Said once: Limits gives the count with the names one press away; every other body one short line (11-22 #31).
  const lineOf = (id: string) => screen.findAllByType(SurfaceFreshnessLine).find(node => node.props.testID === id);
  expect.soft(lineOf('cap.state')?.props.reason).toMatch(/ownership/i);
  expect.soft(lineOf('cap.state')?.props.reason).not.toMatch(/Vercel/);
  expect.soft(screen.findByTestId('cap.state.heldBack')).toBeTruthy();
  expect.soft(lineOf('fit.state')?.props.reason).toContain(t('usage.board.plans.heldBackOwnership'));
  expect.soft(lineOf('fit.state')?.props.reason).not.toMatch(/Vercel/);
  for (const id of ['cap.state', 'fit.state']) expect.soft(lineOf(id)?.props.action?.label).toBe(t('common.retry'));
  expect.soft(screen.findByTestId('cap.none')).toBeFalsy();
  expect.soft(screen.findByTestId('fit.none')).toBeFalsy();
  expect.soft(screen.findByTestId(`cap.cell.${accountId}`)).toBeFalsy();
  expect.soft(screen.findByTestId(`fit.plan.${accountId}`)).toBeFalsy();
  expect.soft(screen.findByTestId('cap.unread')).toBeFalsy();
  expect.soft(screen.getTextContent()).not.toContain(t('usage.board.plans.capacityNotRead', { count: 1 }));
  const headline = screen.findHostByTestId('cap.tightest');
  if (sibling === 'measured') {
    expect.soft(headline?.props.accessibilityLabel).toContain('80%');
    expect(spokenPlanText(screen.findHostByTestId('fit.plan.work')!).join(' ')).toContain(formatUsageCost(amount, 'USD'));
  } else {
    expect(headline).toBeFalsy();
  }
  if (sibling === 'pending') {
    expect(screen.findByTestId('fit.reading')).toBeTruthy();
    await screen.update(widgets(sliceFor({ status: 'pending', sources: [pending] })));
    expect(screen.findByTestId('fit.reading')).toBeTruthy();
    expect(screen.findHostByTestId('fit.state')).toBeNull();
  }
});

it('on the Usage page, Limits keeps the ownership refusal as a failure line with its own state and Plan fit says its promise (USAGE-DESIGN-PASS-57 fixes 2, 3)', async () => {
  const { createCanonicalJsonSigningInput } = await import('@happier-dev/protocol/crypto/canonicalJson');
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const { UsageWidgetBatchProvider } = await import('../usageWidgetBatch');
  const { readUsageWidgetQueryOverrides } = await import('../../usageWidgetPageContext');
  const source = { bindingKind: 'account', ref: { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'team-work' } };
  const refusal = { source: `quota:${createCanonicalJsonSigningInput(source)}`, status: 'error' as const, errorCode: 'ownership_unproven' };
  const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), quota: { status: 'error', sources: [refusal] } },
    bundledUsageModelPriceCatalog).results[0]!;
  const refresh = vi.fn<UsageWidgetBodyModel['refresh']>(async () => {});
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
    refreshing: false, refresh } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const body = { model, slice, query, serverId: mountedHome!.homes.mounted!.id };
  const screen = await renderScreen(wrap(<UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(query)} enabled={false}>
    <UsageCapacityWidget {...body} id="usage_capacity" testID="cap" />
    <UsageProjectionsWidget {...body} id="usage_projections" testID="proj" />
    <UsagePlanFitWidget {...body} id="usage_plan_fit" testID="fit" />
  </UsageWidgetBatchProvider>));
  const cards = screen.findAllByType(SurfaceStateCard);
  // A denial keeps its text and glyph: never the empty state's scene.
  const reason = cards.find(node => node.props.testID === 'cap.state.reason');
  expect(reason?.props.kind).toBe('unavailable');
  expect(reason?.props.size).toBe('line');
  expect(reason?.props.title).toMatch(/ownership/i);
  await screen.pressByTestIdAsync('cap.state.reason-action');
  expect(refresh.mock.calls.map(call => call[1])).toEqual([{ failedOnly: true }]);
  expect(cards.filter(node => node.props.kind === 'empty' && node.props.size !== 'line')).toHaveLength(0);
  // Said once: the derived widget says only what it will show.
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.heldBackOwnership'));
  expect(screen.getTextContent()).toContain(t('usage.board.plans.planFitNoneConnected'));
});

it('says "nothing connected" once: Capacity owns the cause, the widgets derived from it say what they will show (Plans ×4)', async () => {
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), quota: { status: 'available', value: [] } }, bundledUsageModelPriceCatalog).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
    refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const body = { model, slice, query, serverId: mountedHome!.homes.mounted!.id };
  const screen = await renderScreen(wrap(<>
    <UsageCapacityWidget {...body} id="usage_capacity" testID="cap" />
    <UsageProjectionsWidget {...body} id="usage_projections" testID="proj" />
    <UsageResetPlannerWidget {...body} id="usage_resets" testID="resets" />
    <UsagePlanFitWidget {...body} id="usage_plan_fit" testID="fit" />
  </>));
  const cause = t('usage.board.plans.capacitySignInTitle');
  expect(screen.getTextContent().split(cause).length - 1).toBe(1);
  const titles = screen.findAllByType(SurfaceStateCard).map((state) => state.props.title);
  expect(titles).toEqual([
    cause,
    t('usage.board.plans.projectionsNoneConnected'),
    t('usage.board.plans.resetsNoneConnected'),
    t('usage.board.plans.planFitNoneConnected'),
  ]);
  // Only the cause draws the connect scene; each derived widget is one quiet line beside it (R8 #3).
  expect(screen.findAllByType(SurfaceStateCard).map((state) => [state.props.scene ?? null, state.props.size ?? null]))
    .toEqual([['connectAccount', null], [null, 'line'], [null, 'line'], [null, 'line']]);
});

it('asks whose order to show when several Machines are in scope, instead of calling the order unreadable (QA U2)', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY };
  // Machine inventory and mounted commands share the restored Home and its authenticated Account.
  // Machines = All with two online Machines: the Resource has no single selector to read (`unknown`, no Machine id).
  const ambiguous = (groupId: string, memberAccountIds: string[]) => ({
    group: { service, groupId }, memberAccountIds, activeAccountId: memberAccountIds[0]!, selection: { status: 'unknown' as const },
  });
  const props = bodyProps(['a', 'b', 'c'].map((id) => quotaRead(id, now, [weekly])),
    [{ query, value: [ambiguous('first', ['a', 'b']), ambiguous('second', ['c'])] }]);
  const scope = storage.getState().profileScope!;
  storage.getState().applyMachines([
    createMachineFixture({ id: 'desk', activeAt: now, metadata: { ...createMachineFixture().metadata!, displayName: 'Desk' } }),
    createMachineFixture({ id: 'build', activeAt: now, metadata: { ...createMachineFixture().metadata!, displayName: 'Build box' } }),
  ], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  recordMachineRequestSucceeded({ serverId: scope.serverId, accountId: scope.accountId, machineId: 'desk' });
  recordMachineRequestSucceeded({ serverId: scope.serverId, accountId: scope.accountId, machineId: 'build' });
  const chosen: string[] = [];
  const drill = { available: () => true, selected: () => false, toggle: (field: string, id: string) => { chosen.push(`${field}:${id}`); return true; } };
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageDrillProvider } = await import('../../usageDrill');
  const screen = await renderScreen(wrap(<UsageDrillProvider value={drill}>
    <UsageCapacityWidget {...props} id="usage_capacity" testID="cap" />
  </UsageDrillProvider>));
  const text = screen.getTextContent();
  expect(text).not.toContain(t('usage.board.plans.usedFirstReadFailed'));
  expect(text).not.toContain(t('usage.board.plans.usedFirstNoMachine'));
  // The cause is said once for both pools, with the one way forward beside it.
  expect(text.split(t('usage.board.plans.usedFirstPerMachine')).length - 1).toBe(1);
  const chooser = screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'cap.usedFirst.chooseMachine')!;
  expect(chooser).toBeTruthy();
  expect(chooser.props.items.map((item: { id: string; title: string }) => [item.id, item.title]).sort())
    .toEqual([['build', 'Build box'], ['desk', 'Desk']]);
  await invokePlanCommand(t('usage.board.plans.usedFirstChooseMachine'));
  expect(chooser.props.open).toBe(true);
  await act(async () => chooser.props.onOpenChange(false));
  expect(chooser.props.open).toBe(false);
  await act(async () => chooser.props.onSelect('desk'));
  expect(chosen).toEqual(['machines:desk']);
});

it('keeps one unordered pool on one quiet line, and titles the unordered pools "Other pools" beside an ordered one (D2, R4)', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY };
  const unread = (groupId: string, memberAccountIds: string[]) => ({
    group: { service, groupId }, memberAccountIds, activeAccountId: memberAccountIds[0]!,
    selection: { status: 'unsupported' as const, errorCode: 'no_machine' as const },
  });
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const text = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.getTextContent();
  const used = t('usage.board.plans.queueTitle');
  const other = t('usage.board.plans.queueOtherTitle');
  // One unordered pool: the label and the name are one line, not a label standing over the name.
  const single = bodyProps(['a', 'b'].map((id) => quotaRead(id, now, [weekly])), [{ query, value: [unread('first', ['a', 'b'])] }]);
  const alone = await renderScreen(wrap(<UsageCapacityWidget {...single} id="usage_capacity" testID="cap" />));
  expect(alone.findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.startsWith('cap.usedFirst.first'))).not.toHaveLength(0);
  expect(text(alone)).toMatch(new RegExp(`${used} · \\S`));
  // Beside a pool that shows an order, the unordered pools are not a second "Used first".
  const candidate = (profileId: string, priority: number) => ({ profileId, priority, createdAtMs: 1, enabled: true, leastLimitedScore: 62, preferenceDeadlineMs: now + 2 * DAY });
  const ordered = { group: { service, groupId: 'ordered' }, memberAccountIds: ['a', 'b'], activeAccountId: 'a',
    selection: { status: 'available' as const, machineId: 'witnessed-selector', value: { group: { service, groupId: 'ordered' }, observedAtMs: now,
      selection: { selected: candidate('a', 0), reason: 'selected' as const, excluded: [], decisionTrace: { activeProfileId: 'a', reason: 'selected' as const,
        strategy: 'expiry_first' as const, selectionBasis: 'active_stickiness' as const, sticky: true,
        orderedEligibleCandidates: [candidate('a', 0), candidate('b', 1)], candidates: [] } } } } };
  const mixed = bodyProps(['a', 'b', 'c', 'd'].map((id) => quotaRead(id, now, [weekly])), [{ query, value: [ordered, unread('second', ['c']), unread('third', ['d'])] }]);
  const both = await renderScreen(wrap(<UsageCapacityWidget {...mixed} id="usage_capacity" testID="cap" />));
  expect(text(both).split(other).length - 1).toBe(1);
  expect(text(both).split(`${used} ·`).length - 1).toBe(1);
  expect(text(both).split(used).length - 1).toBe(1);
  // A phone's full Plans view keeps the order's row anatomy (place, account, reason, figure) rather than folding the
  // rest into one cut sentence (acceptance 11-22 #43).
  const four = bodyProps(['a', 'b', 'c', 'd'].map((id) => quotaRead(id, now, [weekly])), [{ query, value: [{ ...ordered,
    memberAccountIds: ['a', 'b', 'c', 'd'] }] }]);
  const phone = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'large',
    footprint: { columns: 1, columnSpan: 1, rowSpan: 1, width: 'full', height: 'regular' }, geometry: { width: 358, height: 900 } }}>
    <UsageCapacityWidget {...four} id="usage_capacity" testID="cap" />
  </WidgetPresentationProvider>));
  expect(phone.findHostByTestId('cap.accounts')).not.toBeNull();
  expect(phone.findHostByTestId('cap.steps')).toBeNull();
  expect(phone.findHostByTestId('cap.usedFirst.ordered.a')).not.toBeNull();
  expect(phone.findHostByTestId('cap.usedFirst.ordered.b')).not.toBeNull();
});

/** One earlier week of the same record and meter in accepted history: two readings, one and three days in. */
function withEarlierWeek(read: ConnectedServiceQuotaGetResultV1, weekly: Meter): ConnectedServiceQuotaGetResultV1 {
  const current = read.current!;
  const earlierReset = weekly.resetAtMs - weekly.windowDurationMs;
  const reading = (id: string, observedAtMs: number, usedPct: number) => ({ id, observedAtMs, snapshot: { ...current,
    observedAtMs, fetchedAtMs: observedAtMs,
    meters: current.meters.map((meter) => meter.meterId === 'weekly'
      ? { ...meter, usedPct, utilizationPct: usedPct, resetAtMs: earlierReset, resetsAt: earlierReset } : meter) } });
  const start = earlierReset - weekly.windowDurationMs;
  return ConnectedServiceQuotaGetResultV1Schema.parse({ ...read, history: { nextCursor: null,
    entries: [reading('w1', start + DAY, 10), reading('w3', start + 3 * DAY, 50)] } });
}

it('charts the picked window in the same chart, labels the empirical range with its readings and discloses past cycles', async () => {
  const now = Date.now();
  const weekly: Meter = {
    meterId: 'weekly',
    label: 'Weekly',
    usedPct: 80,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  };
  const session: Meter = {
    meterId: 'session',
    label: 'Five hour',
    usedPct: 20,
    resetAtMs: now + 2 * HOUR,
    windowDurationMs: 5 * HOUR,
  };
  const base = quotaRead('work', now, [weekly, session]);
  const recordId = base.current!.recordId;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    ...base,
    unusedCapacity: {
      historyStatus: 'returned_page',
      windows: [
        {
          window: {
            recordId,
            meterId: 'weekly',
            resetAtMs: weekly.resetAtMs - 7 * DAY,
            windowStartAtMs: weekly.resetAtMs - 14 * DAY,
            windowDurationMs: 7 * DAY,
          },
          value: {
            status: 'available',
            unusedAmount: 23,
            unusedFraction: 0.23,
            unit: 'percent',
            observedAtMs: now - 5 * DAY,
            sampleCount: 5,
            qualification: 'confirmed',
            method: 'terminal_observation',
          },
        },
      ],
    },
  });
  const props = bodyProps([withEarlierWeek(read, weekly)]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(
    wrap(
      <UsageProjectionsWidget
        {...props}
        id="usage_projections"
        testID="proj"
      />,
    ),
  );
  const chart = () =>
    screen
      .findAllByType(BurnUpChart)
      .find((node) => node.props.testID === 'proj.burnUp')!;
  const first = chart();
  await act(async () => screen.findHostByTestId('proj.burnUp')!.props.onLayout({ nativeEvent: { layout: { width: 320, height: 150 } } }));
  const band = screen.findByTestId('proj.burnUp-band-empirical-0');
  expect(band).toBeTruthy();
  expect(band!.props.d).toContain(' Z');
  expect(first.props.label).toContain('Weekly');
  // The earlier comparable week is a ghost curve on this window's axis; the spread lines are not.
  const ghosts = first.props.series.filter((entry: { id: string }) => entry.id.startsWith('earlier:'));
  expect(ghosts).toHaveLength(1);
  expect(ghosts[0].points.map((point: { x: number; y: number }) => [point.x - (weekly.resetAtMs - weekly.windowDurationMs), point.y]))
    .toEqual([[DAY, 10], [3 * DAY, 50]]);
  expect(first.props.series.some((entry: { id: string }) => entry.id === 'rangeLow')).toBe(true);
  // A pace that runs out draws to the limit and stops there, never past 100% (no "160%" scale).
  const projected = first.props.series.find((entry: { id: string }) => entry.id === 'projected');
  expect(Math.max(...projected.points.map((point: { y: number }) => point.y))).toBe(100);
  expect(projected.points.at(-1).x).toBeLessThanOrEqual(weekly.resetAtMs);
  expect(screen.findHostByTestId('proj.earlier')!.props.accessibilityLabel).toContain('1');
  const range = screen.findHostByTestId('proj.range')!.props.accessibilityLabel as string;
  // The owner's own spread (0.6–0.9 of the window at the reset) with its real reading count.
  expect(range).toContain('60%');
  expect(range).toContain('90%');
  expect(range).toContain('7');
  expect(screen.findByTestId('proj.multiple.work.session')).toBeNull();
  await screen.pressByTestIdAsync('proj.reported-header');
  expect(screen.findByTestId('proj.multiple.work.session')).toBeTruthy();
  expect(screen.findByTestId('proj.pastCycles.row.0')).toBeNull();
  await screen.pressByTestIdAsync('proj.pastCycles-header');
  // 1 − 0.23 unused: the ended window's recorded used share.
  expect(
    screen.findHostByTestId('proj.pastCycles.row.0')!.props.accessibilityLabel,
  ).toContain('77%');
  const picker = screen
    .findAllByType(DropdownMenu)
    .find((node) => node.props.testID === 'proj.windowPicker')!;
  expect(
    picker.props.items.map((item: { id: string }) => item.id),
  ).toHaveLength(2);
  const sessionKey = picker.props.items.find((item: { title: string }) =>
    item.title.includes('Five hour'),
  ).id;
  await act(async () => picker.props.onSelect(sessionKey));
  expect(chart().props.label).toContain('Five hour');
  expect(chart()).toBe(first);
});

it.each([
  { placement: 'omitted period', session: 's1', period: {}, exact: true },
  { placement: 'omitted period with duplicate Session values', session: ['s1', 's1'], period: {}, exact: true },
  { placement: 'explicit All', session: 's1', period: { relative: 'all' }, exact: false },
  { placement: 'explicit Year', session: 's1', period: { relative: 'year' }, exact: false },
])('reads saved Resets history as on the loaded cut for $placement', async ({ session, period, exact }) => {
  const now = Date.now();
  const read = quotaRead('work', now, [
    { meterId: 'weekly', label: 'Weekly', usedPct: 80, resetAtMs: now + DAY, windowDurationMs: 7 * DAY },
  ]);
  const profile = AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4: [{
    ref: read.source.ref, status: 'connected', authenticationModeId: 'manual',
    revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
    configurationReady: false, configurationRevision: null, scopes: [],
  }] });
  // The accepted raw observation is readable before its day summary has been published.
  const accepted = { id: 'accepted', observedAtMs: now };
  const { server, credentials, setReading } = await serveResetStartHome('https://usage-saved-reset.test', {
    profile, missingSummaryFor: accepted,
  });
  setReading(ConnectedServiceQuotaGetResultV1Schema.parse({
    ...read, history: { nextCursor: null, entries: [{ ...accepted, snapshot: read.current }] },
  }));
  const previous = storage.getState().sessionPending;
  storage.setState({
    profileScope: { serverId: server.id, accountId: profile.id }, profile,
    sessionPending: { ...previous, s1: { messages: exact ? [{ id: 'p1', localId: 'local-1', createdAt: now,
      updatedAt: now, text: 'Run the follow-up', rawRecord: null }] : [], discarded: [], isLoaded: true } },
  });
  try {
    const { readBuiltinWidgetDescriptorV1, resolveWidgetBindingsV1, WidgetInstanceV1Schema } = await import('@happier-dev/protocol/widgets');
    const { UsageWidgetBody } = await import('../UsageWidgetBody');
    const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
    const instance = WidgetInstanceV1Schema.parse({
      v: 1, id: 'saved-resets', definition: { kind: 'builtin', id: 'usage_resets' },
      bindings: { session: { kind: 'value', value: session }, period: { kind: 'value', value: period },
        costBasis: { kind: 'value', value: 'auto' } },
    });
    const descriptor = readBuiltinWidgetDescriptorV1(instance.definition)!;
    const binding = resolveWidgetBindingsV1({ instance, fields: descriptor.inputs!.fields, context: {}, viewerValues: {} });
    expect(binding.status).toBe('ready');
    if (binding.status !== 'ready') throw new Error('Saved Resets bindings were refused');
    const screen = await renderScreen(wrap(
      <UsageWidgetBody id="usage_resets" input={binding.input} serverId={server.id} testID="saved-resets" />, credentials,
    ));
    try {
      const props = () => screen.findAllByType(UsageResetPlannerWidget)[0]?.props;
      await expect.poll(() => props()?.slice.quota?.[0]?.current?.fetchedAtMs).toBe(now);
      await expect.poll(() => props()?.slice.pending).toBe(false);
      const historyRequests = comparisonHome!.requests.filter(request => request.method === 'GET'
        && request.path.endsWith('/provider-account-usage/history'));
      if (!exact) {
        expect(comparisonHome!.requests.some(request => request.path.endsWith('/provider-account-usage/day-summaries'))).toBe(true);
        expect(historyRequests).toHaveLength(0);
        expect(props()?.slice.quota?.[0]?.pageFacts?.resetWitness).toBeNull();
        return;
      }
      expect(historyRequests.length).toBeGreaterThan(0);
      expect.soft(props()?.slice.quota?.[0]?.pageFacts?.resetWitness?.id).toBe('accepted');
      const picker = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'saved-resets.resetStart.local-1.pick');
      expect(picker?.props.items).toHaveLength(1);
      await invokePlanCommand(t('usage.board.plans.resetStartAction'));
      expect(picker?.props.open).toBe(true);
    } finally {
      await screen.unmount();
    }
  } finally {
    storage.setState({ sessionPending: previous });
  }
});

it("binds one Session's pending message to a reset with the exact witnessed input, and withholds the control without a witness", async () => {
  const now = Date.now();
  const { server, credentials, requests, setReading } = await serveResetStartHome('https://usage-plans.test');
  const previous = storage.getState();
  storage.setState({
    profileScope: { serverId: server.id, accountId: 'account-a' },
    sessionPending: {
      ...previous.sessionPending,
      s1: {
        messages: [
          {
            id: 'p1',
            localId: 'local-1',
            createdAt: now,
            updatedAt: now,
            text: 'Run the big refactor',
            rawRecord: null,
          },
        ],
        discarded: [],
        isLoaded: true,
      },
    },
  } as Partial<typeof previous> as typeof previous);
  try {
    const weekly: Meter = {
      meterId: 'weekly',
      label: 'Weekly',
      usedPct: 80,
      resetAtMs: now + 2 * DAY,
      windowDurationMs: 7 * DAY,
    };
    const bare = quotaRead('work', now, [weekly]);
    const witnessed = ConnectedServiceQuotaGetResultV1Schema.parse({
      ...bare,
      history: {
        nextCursor: null,
        entries: [{ id: 'entry-9', observedAtMs: now, snapshot: bare.current }],
      },
    });
    setReading(witnessed);
    const sessionQuery = normalizeUsageQuery({ session: 's1' });
    const { UsageResetPlannerWidget } =
      await import('../UsageResetPlannerWidget');
    const none = await renderScreen(
      wrap(
        <UsageResetPlannerWidget
          {...bodyProps([bare], undefined, sessionQuery)}
          serverId={server.id}
          id="usage_resets"
          testID="reset"
        />, credentials,
      ),
    );
    expect(none.findByTestId('reset.resetStart.unavailable')).toBeTruthy();
    expect(
      none
        .findAllByType(DropdownMenu)
        .some((node) => node.props.testID === 'reset.resetStart.local-1.pick'),
    ).toBe(false);
    expect(requests()).toEqual([]);
    await none.unmount();
    const screen = await renderScreen(
      wrap(
        <UsageResetPlannerWidget
          {...bodyProps([witnessed], undefined, sessionQuery)}
          serverId={server.id}
          id="usage_resets"
          testID="reset"
        />, credentials,
      ),
    );
    const picker = screen
      .findAllByType(DropdownMenu)
      .find((node) => node.props.testID === 'reset.resetStart.local-1.pick')!;
    await invokePlanCommand(t('usage.board.plans.resetStartAction'));
    expect(picker.props.open).toBe(true);
    await act(async () => picker.props.onOpenChange(false));
    expect(picker.props.open).toBe(false);
    await act(async () => {
      picker.props.onSelect(picker.props.items[0].id);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).toBeTruthy());
    expect(requests()).toEqual([]);
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toEqual({
      path: '/v2/sessions/s1/pending/local-1/action', accountId: 'account-a', body: { requestedAction: { v: 1, kind: 'reset_start',
      reset: {
        source: witnessed.source,
        recordId: witnessed.current!.recordId,
        meterId: 'weekly',
        witness: { id: 'entry-9', observedAtMs: now },
      } } },
    });
  } finally {
    storage.setState({
      profileScope: previous.profileScope,
      sessionPending: previous.sessionPending,
    });
  }
});

it('binds Account-wide queued identities once across accounts without reading private Pending text or granting unavailable authority', async () => {
  const now = Date.now();
  const { server, credentials, requests, setReading } = await serveResetStartHome('https://usage-account-plans.test');
  const previous = storage.getState();
  const privateText = 'Private queued request';
  storage.setState({
    profileScope: { serverId: server.id, accountId: 'account-a' },
    sessionPending: {
      ...previous.sessionPending,
      s1: { messages: [{ id: 'p1', localId: 'local-1', createdAt: now, updatedAt: now, text: privateText, rawRecord: null }], discarded: [], isLoaded: true },
    },
  });
  try {
    const unboundEntries = [
      { sessionId: 's1', localId: 'local-1', authorityCurrent: true },
      { sessionId: 's2', localId: 'local-1', authorityCurrent: false },
      ...Array.from({ length: 10 }, (_, index) => ({ sessionId: `queued-session-${index}`, localId: `queued-local-${index}`, authorityCurrent: true })),
    ];
    const reads = ['work', 'personal'].map(accountId => {
      const bare = quotaRead(accountId, now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY }]);
      return ConnectedServiceQuotaGetResultV1Schema.parse({
        ...bare,
        history: { nextCursor: null, entries: [{ id: `accepted-${accountId}`, observedAtMs: now, snapshot: bare.current }] },
        waitingWork: { status: 'available', entries: [], unboundEntries },
      });
    });
    setReading(reads[0]!);
    const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
    const screen = await renderScreen(wrap(<UsageResetPlannerWidget {...bodyProps(reads)} serverId={server.id} id="usage_resets" testID="reset" />, credentials));
    const pickers = () => screen.findAllByType(DropdownMenu).filter(node => String(node.props.testID).startsWith('reset.resetStart.'));
    // The list leads with its first rows; the rest wait behind the shared Show all, and the entry this viewer
    // cannot hold is one quiet line with its reason instead of a disabled row.
    expect(pickers()).toHaveLength(6);
    expect(pickers().some(node => String(node.props.testID).includes('s2'))).toBe(false);
    expect(screen.getTextContent()).toContain(t('usage.board.plans.resetStartUnavailableCount', { count: 1 }));
    // No Session or message id is ever drawn, whether or not the Session is loaded here.
    expect(screen.getTextContent()).not.toMatch(/local-|queued-session|\bs[12]\b/);
    expect(screen.getTextContent()).not.toContain(privateText);
    await act(async () => { screen.findByTestId('reset.resetStart.more.toggle')!.props.onPress(); });
    expect(pickers()).toHaveLength(11);
    const available = pickers().find(node => node.props.testID === 'reset.resetStart.s1.local-1.pick')!;
    await act(async () => {
      available.props.onSelect(available.props.items[0].id);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).toBeTruthy());
    expect(requests()).toEqual([]);
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toEqual({
      path: '/v2/sessions/s1/pending/local-1/action', accountId: 'account-a', body: { requestedAction: { v: 1, kind: 'reset_start',
      reset: { source: reads[0]!.source, recordId: reads[0]!.current!.recordId, meterId: 'weekly', witness: { id: 'accepted-work', observedAtMs: now } },
    } } });
    expect(JSON.stringify(requests())).not.toContain(privateText);
  } finally {
    storage.setState({ profileScope: previous.profileScope, sessionPending: previous.sessionPending });
  }
});

it("says what a banked reset's expiry means against the natural reset, and counts plan fit over witnessed windows only", async () => {
  const now = Date.now();
  const weekly: Meter = {
    meterId: 'weekly',
    label: 'Weekly',
    usedPct: 80,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  };
  const base = quotaRead(
    'work',
    now,
    [weekly],
    {},
    {
      recoveryCredits: {
        availableCount: 1,
        nextExpiresAtMs: now + DAY,
        credits: [
          {
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: now + DAY,
          },
        ],
      },
    },
  );
  const recordId = base.current!.recordId;
  const ended = (weeks: number, unusedFraction: number) => ({
    window: {
      recordId,
      meterId: 'weekly',
      resetAtMs: weekly.resetAtMs - weeks * 7 * DAY,
      windowStartAtMs: weekly.resetAtMs - (weeks + 1) * 7 * DAY,
      windowDurationMs: 7 * DAY,
    },
    value: {
      status: 'available',
      unusedAmount: unusedFraction * 100,
      unusedFraction,
      unit: 'percent',
      observedAtMs: now - weeks * 7 * DAY,
      sampleCount: 3,
      qualification: 'confirmed',
      method: 'terminal_observation',
    },
  });
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    ...base,
    unusedCapacity: {
      historyStatus: 'returned_page',
      windows: [ended(1, 0), ended(2, 0.4), ended(3, 0.5)],
    },
  });
  const { UsageResetPlannerWidget } =
    await import('../UsageResetPlannerWidget');
  const resets = await renderScreen(
    wrap(
      <UsageResetPlannerWidget
        {...bodyProps([read])}
        id="usage_resets"
        testID="reset"
      />,
    ),
  );
  expect(
    resets.findHostByTestId('reset.wallet.work.advice')!.props.children,
  ).toBeTruthy();
  expect(resets.findByTestId('reset.list.0')).toBeTruthy();
  expect(resets.findHostByTestId('reset.resetStart')).toBeNull();
  await resets.unmount();
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const fit = await renderScreen(
    wrap(
      <UsagePlanFitWidget
        {...bodyProps([read, quotaRead('other', now, [weekly])])}
        id="usage_plan_fit"
        testID="fit"
      />,
    ),
  );
  // Neither plan has a price, so the rows wait one press away (acceptance 11-21 #3).
  await fit.pressByTestIdAsync('fit.plans-header');
  const label = fit.findHostByTestId('fit.plan.work.fit')!.props
    .accessibilityLabel as string;
  expect(label).toContain('1');
  expect(label).toContain('3');
  expect(fit.findByTestId('fit.plan.other.fit.insufficient')).toBeTruthy();
});

it('promises later detail only for history gaps', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const render = async (reason: string) => {
    const props = bodyProps([read]);
    const source = { ref: { accountId: 'work', service: { pluginId: 'p', localId: 'l' } } };
    const slice = { ...props.slice, planInsights: { recordedWeek: { status: 'available', recordedActiveDays: 1, recordedEvents: 1, coverage: 'complete_recorded_history' },
      accounts: [{ source, value: { status: 'insufficient_basis', reason: 'account_usage_unpriced' }, weather: [], modelHeadroom: [],
        pricePerReset: [{ meterId: 'weekly', label: 'Weekly', status: 'insufficient_basis', reason }] }] } } as unknown as typeof props.slice;
    return renderScreen(wrap(<UsagePlanFitWidget {...props} slice={slice} id="usage_plan_fit" testID="fit" />));
  };
  const priceGap = await render('period_price_unavailable');
  expect(priceGap.getTextContent()).not.toContain(t('usage.board.plans.moreDetailLater'));
  expect(priceGap.getTextContent()).not.toContain(t('usage.board.plans.attributionNote'));
  await priceGap.unmount();
  const historyGap = await render('recorded_resets_unavailable');
  expect(historyGap.getTextContent()).toContain(t('usage.board.plans.moreDetailLater'));
  await historyGap.unmount();
});

it('shows the list-price observation date in the selected app language', async () => {
  const previousLanguage = getPreferredLanguage();
  const appLanguage = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('fr') ? 'de' : 'fr';
  await preloadTranslationsForSettings(appLanguage);
  setPreferredLanguageFromSettings(appLanguage);
  try {
    const now = Date.now();
    const asOfMs = now - 30 * DAY;
    const period = { startAtMs: now - DAY, endAtMs: now + 2 * DAY };
    const read = quotaRead('work', now, [], {}, {
      subscription: {
        status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: HOUR,
        currentPeriodStartAtMs: period.startAtMs, currentPeriodEndAtMs: period.endAtMs,
        monetaryFacts: [{
          kind: 'list', amount: 20, currency: 'USD', period,
          source: { kind: 'published', id: 'provider-list', version: '2026-09' },
          effectiveAtMs: asOfMs, asOfMs,
        }],
      },
    });
    const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
    const screen = await renderScreen(wrap(
      <UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />,
    ));
    const options = { day: 'numeric', month: 'short', year: 'numeric' } as const;
    const expected = new Intl.DateTimeFormat(appLanguage, options).format(asOfMs);
    const deviceDate = new Intl.DateTimeFormat(undefined, options).format(asOfMs);
    expect(expected).not.toBe(deviceDate);
    expect(spokenPlanText(screen.findHostByTestId('fit.plan.work')!).join(' ')).toContain(expected);
  } finally {
    setPreferredLanguageFromSettings(previousLanguage);
  }
});


it.each(['waiting', 'unbound'] as const)('conceals hidden reset-plan Session labels while keeping configured %s work', async kind => {
  const now = Date.now();
  const { server, credentials } = await serveResetStartHome('https://usage-reset-privacy.test');
  const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
  const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
  const previous = storage.getState();
  const session = createSessionFixture({ id: 'private-reset', serverId: server.id, metadata: {
    name: 'Private reset project', path: '/private-reset', host: 'host', machineId: 'machine',
  } });
  storage.setState({ sessions: { [session.id]: session } });
  const bare = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY }]);
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({ ...bare,
    history: { nextCursor: null, entries: [{ id: 'private-reset-reading', observedAtMs: now, snapshot: bare.current }] },
    waitingWork: { status: 'available',
    unboundEntries: kind === 'unbound' ? [{ sessionId: session.id, localId: 'private-wait', authorityCurrent: true }] : [],
    entries: kind === 'waiting' ? [{ sessionId: session.id, localId: 'private-wait', recordId: bare.current!.recordId, meterId: 'weekly', readiness: { status: 'ready' } }] : [] } });
  const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
  const screen = await renderScreen(wrap(<UsageResetPlannerWidget {...bodyProps([read])} serverId={server.id} id="usage_resets" testID="reset-privacy" />, credentials));
  try {
    expect(screen.getTextContent()).toContain('Private reset project');
    await act(async () => {
      storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [server.id]: ['private'] } });
      storage.getState().setSessionTagAssignmentsOptimistic(server.id, session.id, ['private']);
      setScreenSharingPrivacyActive(true);
    });
    expect(screen.getTextContent()).not.toContain('Private reset project');
    expect(screen.findByTestId(kind === 'waiting' ? 'reset-privacy.waiting.private-wait.cancel'
      : 'reset-privacy.resetStart.private-reset.private-wait.open')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(session.id);
    await act(async () => { setScreenSharingPrivacyActive(false); });
    expect(screen.getTextContent()).toContain('Private reset project');
  } finally { setScreenSharingPrivacyActive(false); await screen.unmount(); storage.setState(previous, true); }
});
