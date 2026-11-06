import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen as renderScreenAtHost, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { OverlayPortalProvider, OverlayPortalHost } from '@/components/ui/popover/OverlayPortal';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ConnectedServicePoolSelectionGetRequestV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } from '@/text';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { captureUiUsageQueryAccountContext, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import {
  ConnectedServiceQuotaGetResultV1Schema,
  type ConnectedServiceQuotaGetResultV1,
} from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { BurnUpChart, ChartDatum } from '@happier-dev/plugin-ui/presentation';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { UsageWidgetBodyModel } from '../../useUsageWidgetResource';

// Machine RPC and the served Home's Artifact persistence are the external boundaries.
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
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let previousProfile = storage.getState().profile;
let previousProfileScope = storage.getState().profileScope;
let restoreFrameBoundary: (() => void) | undefined;
let restoreActionModuleLoader: (() => void) | undefined;
beforeEach(() => {
  restoreFrameBoundary = withPopoverWebGlobals();
  previousSnapshot = getAppliedActiveServerSnapshot();
  previousAvailable = isAppliedActiveServerRuntimeAvailable();
  previousProfile = storage.getState().profile;
  previousProfileScope = storage.getState().profileScope;
});
afterEach(async () => {
  standardCleanup();
  restoreFrameBoundary?.();
  restoreActionModuleLoader?.(); restoreActionModuleLoader = undefined;
  selectionTransport.mockReset();
  await comparisonHome?.dispose(); comparisonHome = undefined;
  (
    await import('@/sync/domains/scope/activeServerAccountScope')
  ).retireActiveServerAccountScopeLifetime();
  publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
  storage.setState({ profile: previousProfile, profileScope: previousProfileScope });
});

async function serveResetStartApprovalHome(serverUrl: string) {
  const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
  const settings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
    'session.pending.resetStart.set': { approvalRequiredSurfaces: ['ui'] },
  } }) };
  comparisonHome = await serveAccountHomes({ homes: [{ key: 'reset', serverUrl, accountId: 'account-a', currentAccount: true, settings }],
    route: request => {
      if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      return artifacts.handle(request.path, { method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) ?? undefined;
    } });
  restoreActionModuleLoader = await installRealActionExecutorModuleLoader();
  const server = comparisonHome.homes.reset!;
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const requests = () => artifacts.list().map(artifact => ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifact.id) ?? 'null')));
  return { server, credentials, requests };
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
    storage.setState({ profileScope: { serverId, accountId }, profile: AccountProfileSchema.parse({ ...storage.getState().profile, id: accountId,
      connectedAccountGroupsV4: pools.flatMap(read => read.value ?? []).map(pool => QualifiedConnectedAccountGroupV4Schema.parse({
        v: 1, ref: pool.group, displayName: pool.group.groupId, incarnation: `${pool.group.groupId}:1`,
        policy: { strategy: 'priority' }, generation: 1, runtimeStateRevision: 1, state: {}, members: [],
        activeConnectedAccountId: null, createdAt: 1, updatedAt: 1,
      })),
    }) });
  }
  const slice = resolveUsagePageAggregation({
    queries: [shownQuery],
    nowMs: Date.now(),
    previous,
    quota: { status: 'available', value: [...quota] },
    ...(pools ? { pools } : {}),
  }).results[0]!;
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
  return { model, slice, query: shownQuery, serverId: 'home' };
}

const wrap = (node: React.ReactElement, credentials: React.ComponentProps<typeof InjectedAuthProvider>['credentials'] = null) => (
  <InjectedAuthProvider credentials={credentials}>
    <OverlayPortalProvider>{node}<OverlayPortalHost /></OverlayPortalProvider>
  </InjectedAuthProvider>
);

// Native measurement is the physical boundary; Popover open/close, placement and portal owners run.
const renderScreen = (node: Parameters<typeof renderScreenAtHost>[0]) => renderScreenAtHost(node, {
  createNodeMock: () => ({
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(200, 200, 120, 32),
  }),
});

it('reveals exact projected percent points without rounding the admitted projection headline', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30.125,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([read])} id="usage_projections" testID="proj" />));
  expect(screen.findAllByType(ChartDatum).find(node => node.props.testID === 'proj.headline.detail')?.props.datum.value).toBe('60.25%');
});

it('shows the canonical capacity weather and insufficient model/reset basis inside the existing plan fit body', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const other = quotaRead('other', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 20,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...bodyProps([read, other])} id="usage_plan_fit" testID="fit" />));
  // A plan is one row; its basis lines open under Details.
  expect(screen.findByTestId('fit.plan.work.weather.weekly')).toBeFalsy();
  // An unknown plan value is never a lone dash at the row's far edge; when no row has a price, that is said
  // once for the list (R9), never repeated on every row.
  expect(screen.getTextContent()).not.toContain('—');
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.planNoPriceShort'));
  expect(String(screen.findByTestId('fit.once')!.props.children)).toBe(t('usage.board.plans.planNoPriceAll'));
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  expect(screen.findByTestId('fit.plan.work.weather.weekly')).toBeTruthy();
  // What no account has a basis for yet is one line for the whole widget, never one per account.
  expect(screen.findByTestId('fit.plan.work.insufficient')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.other.insufficient')).toBeFalsy();
  // It is one quiet promise, not a list of internal feature names.
  const summary = String(screen.findByTestId('fit.notRecorded')!.props.children);
  expect(summary).toBe(t('usage.board.plans.moreDetailLater'));
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.modelHeadroomTitle'));
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.weekly.insufficient')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.work.pricePerReset.weekly.insufficient')).toBeFalsy();
  expect(screen.findAllByType((await import('@/components/settings/connectedServices/ConnectedServiceMark')).ConnectedServiceMark)
    .find(node => node.props.legacyServiceId === 'claude-subscription')).toBeTruthy();
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
  // The alert's line is in use, so none is held for it.
  expect(screen.findByTestId('proj.aheadRoom')).toBeFalsy();
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
  // Every read has answered and no alert came: no blank line is kept above the legend for one that never arrives.
  expect(screen.findByTestId('proj.aheadRoom')).toBeFalsy();
  // The eight windows without a projection share a cause: said once for the widget, as a partial statement,
  // never as "No projection yet" for the whole list nor beneath every row.
  const text = screen.getTextContent();
  expect(screen.findByTestId('proj.sharedReason')).toBeTruthy();
  expect(text).toContain(t('usage.board.plans.paceSharedReasonSome', { count: 8, reason: t('usage.board.plans.paceNotDerived') }));
  expect(text).not.toContain(t('usage.board.plans.paceSharedReason', { reason: '' }));
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
  const own = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([unpaced])} id="usage_projections" testID="own" />));
  expect(own.findByTestId('own.noPace')).toBeTruthy();
  expect(own.findByTestId('own.reported')).toBeTruthy();
  expect(own.findByTestId('own.legend')).toBeFalsy();
  expect(quiet.getTextContent().split(t('usage.board.plans.paceNotDerived')).length - 1).toBe(1);
});

it('holds the list room its accounts will fill while their first allowance reads are pending, then lets it go', async () => {
  const { QualifiedConnectedServiceUsageSourceV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const sourcesFor = (count: number, status: 'pending' | 'available') => Array.from({ length: count }, (_, index) => ({
    source: `quota:${JSON.stringify(QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
      ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `acct-${index}` } }))}`,
    status,
  }));
  const render = async (count: number, status: 'pending' | 'available') => {
    const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), sources: sourcesFor(count, status),
      ...(status === 'available' ? { quota: { status: 'available' as const, value: [] } } : {}) }).results[0]!;
    const model = { requestedQuery: null, shownQuery: null, slice, pending: status === 'pending', error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
    return renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
      <UsageProjectionsWidget model={model} slice={slice} query={query} serverId="home" id="usage_projections" testID="proj" />
    </WidgetPresentationProvider>));
  };
  const heldRoom = (screen: Awaited<ReturnType<typeof render>>) => {
    const style = ([] as unknown[]).concat(screen.findByTestId('proj.projections')?.props.style ?? []).flat(2);
    return style.reduce<number>((held, entry) => (entry && typeof entry === 'object' && 'minHeight' in entry ? Number(entry.minHeight) : held), 0);
  };
  // Each allowance account is expected to report a session and a longer window, up to the rows a list leads with:
  // reads fill that room as they arrive, and a settled list holds none.
  const five = heldRoom(await render(5, 'pending'));
  const one = heldRoom(await render(1, 'pending'));
  expect(one).toBeGreaterThan(0);
  expect(five).toBeGreaterThan(one);
  expect(heldRoom(await render(3, 'available'))).toBe(0);
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
  }).results[0]!;
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
    } }] }).results[0]!;
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...base} slice={slice} id="usage_plan_fit" testID="fit" />));
  expect(screen.findByTestId('fit.recordedWeek')).toBeTruthy();
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
    quotaRead('work', now, [weekly(30)]),
    quotaRead('personal', now, [weekly(10)]),
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
    selected: candidate('personal', 1),
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
      selectionBasis: 'active_stickiness' as const,
      sticky: true,
      orderedEligibleCandidates: [
        candidate('personal', 1),
        candidate('work', 0),
      ],
      candidates: [
        {
          profileId: 'work',
          decision: 'eligible' as const,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 62,
            capturedAtMs: now - 120_000,
          },
        },
        {
          profileId: 'personal',
          decision: 'selected' as const,
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
            value: { group, observedAtMs: now, selection },
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
  // The Account's own read order is work, personal: the queue follows the selector's order instead.
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
    'cap.usedFirst.pool.personal',
    'cap.usedFirst.pool.work',
    'cap.usedFirst.pool.side',
  ]);
  expect(screen.getTextContent()).toContain('Expiring first');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeNull();
  expect(screen.getTextContent()).not.toContain('62%');
  await screen.pressByTestIdAsync('cap.usedFirst.pool.why');
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
  await act(async () => strategyControl.props.onSelect('priority'));
  await expect.poll(() => screen.findHostByTestId(`${comparison}.candidate.work`) !== null).toBe(true);
  const momentControl = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${comparison}.moment`)!;
  await act(async () => momentControl.props.onSelect(String(now + 3 * HOUR)));
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
  comparisonUnavailable = false;
  await act(async () => { await comparisonEntry.refresh(); });
  expect(screen.findHostByTestId(`${comparison}.candidate.work`)).toBeTruthy();
  const failed = bodyProps(quota, [{ query, value: [{ group, memberAccountIds: ['work', 'personal', 'side'],
    activeAccountId: 'personal', selection: { status: 'error', machineId: 'witnessed-selector', errorCode: 'connected_service_request_failed' } }] }], query,
    { v: 1, results: [props.slice] });
  await screen.update(<InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...failed} serverId={home.id}
    id="usage_capacity" testID="cap" /></InjectedAuthProvider>);
  expect.soft(screen.findHostByTestId('cap.usedFirst.pool.personal')).toBeTruthy();
  expect.soft(screen.getTextContent()).toContain(t('usage.board.plans.usedFirstReadFailed'));
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.hintLoading'));
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
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...props} serverId="home" id="usage_capacity" testID="cap" />));
  expect(screen.findHostByTestId('cap.usedFirst.empty')).toBeTruthy();
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.whyNone'));
  expect(screen.findByTestId('cap.usedFirst.empty.why')).toBeNull();
  expect(screen.getTextContent()).not.toContain('Expiring first');
  await screen.update(wrap(<WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
    <UsageCapacityWidget {...props} serverId="home" id="usage_capacity" testID="cap" />
  </WidgetPresentationProvider>));
  expect(screen.getTextContent()).toContain('empty');
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.whyNone'));
  const excluded = bodyProps(['a', 'b'].map(id => quotaRead(id, now, [weekly])), [{ query, value: [{ group,
    memberAccountIds: ['a', 'b'], activeAccountId: null, selection: { status: 'available', machineId: 'witnessed-selector',
      value: { group, observedAtMs: now, selection: { ...selection, excluded: ['a', 'b'].map(profileId => ({ profileId, reason: 'disabled' as const })) } } } }] }]);
  await screen.update(wrap(<UsageCapacityWidget {...excluded} serverId="home" id="usage_capacity" testID="cap" />));
  await screen.pressByTestIdAsync('cap.usedFirst.empty.why');
  expect(screen.getTextContent()).toContain(t('usage.board.plans.whyNone'));
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
  const screen = await renderScreen(wrap(<UsageCapacityWidget {...props} serverId="home" id="usage_capacity" testID="cap" />));
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
  const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), quota: { status: 'partial', value: [] } }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
    refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(wrap(<UsageCapacityWidget model={model} slice={slice} query={query} serverId="home" id="usage_capacity" testID="cap" />));
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

it('says "nothing connected" once: Capacity owns the cause, the widgets derived from it say what they will show (Plans ×4)', async () => {
  const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
  const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), quota: { status: 'available', value: [] } }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
    refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const body = { model, slice, query, serverId: 'home' };
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
});

it('asks whose order to show when several Machines are in scope, instead of calling the order unreadable (QA U2)', async () => {
  const now = Date.now();
  const weekly: Meter = { meterId: 'weekly', label: 'Weekly', usedPct: 20, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY };
  // The Machine inventory follows the selected Home, while the Resource follows its applied Account.
  const server = await upsertAndActivateServer({ serverUrl: 'https://usage-pool-choices.test' });
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  storage.setState({ profileScope: { serverId: server.id, accountId: 'pool-choices' },
    profile: AccountProfileSchema.parse({ id: 'pool-choices' }) });
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
  const chosen: string[] = [];
  const drill = { available: () => true, selected: () => false, toggle: (field: string, id: string) => { chosen.push(`${field}:${id}`); return true; } };
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageDrillProvider } = await import('../../usageDrill');
  const screen = await renderScreen(wrap(<UsageDrillProvider value={drill}>
    <UsageCapacityWidget {...props} serverId="home" id="usage_capacity" testID="cap" />
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
  const alone = await renderScreen(wrap(<UsageCapacityWidget {...single} serverId="home" id="usage_capacity" testID="cap" />));
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
  const both = await renderScreen(wrap(<UsageCapacityWidget {...mixed} serverId="home" id="usage_capacity" testID="cap" />));
  expect(text(both).split(other).length - 1).toBe(1);
  expect(text(both).split(`${used} ·`).length - 1).toBe(1);
  expect(text(both).split(used).length - 1).toBe(1);
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

it("binds one Session's pending message to a reset with the exact witnessed input, and withholds the control without a witness", async () => {
  const now = Date.now();
  const { server, credentials, requests } = await serveResetStartApprovalHome('https://usage-plans.test');
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
    await act(async () => {
      picker.props.onSelect(picker.props.items[0].id);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]!.actionId).toBe('session.pending.resetStart.set');
    expect(requests()[0]!.actionArgs).toEqual({
      sessionId: 's1',
      localId: 'local-1',
      serverId: server.id,
      reset: {
        source: witnessed.source,
        recordId: witnessed.current!.recordId,
        meterId: 'weekly',
        witness: { id: 'entry-9', observedAtMs: now },
      },
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
  const { server, credentials, requests } = await serveResetStartApprovalHome('https://usage-account-plans.test');
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
    ];
    const reads = ['work', 'personal'].map(accountId => {
      const bare = quotaRead(accountId, now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY }]);
      return ConnectedServiceQuotaGetResultV1Schema.parse({
        ...bare,
        history: { nextCursor: null, entries: [{ id: `accepted-${accountId}`, observedAtMs: now, snapshot: bare.current }] },
        waitingWork: { status: 'available', entries: [], unboundEntries },
      });
    });
    const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
    const screen = await renderScreen(wrap(<UsageResetPlannerWidget {...bodyProps(reads)} serverId={server.id} id="usage_resets" testID="reset" />, credentials));
    const pickers = screen.findAllByType(DropdownMenu).filter(node => String(node.props.testID).startsWith('reset.resetStart.'));
    expect(pickers).toHaveLength(2);
    expect(screen.getTextContent()).not.toContain(privateText);
    const available = pickers.find(node => node.props.testID === 'reset.resetStart.s1.local-1.pick')!;
    const unavailable = pickers.find(node => node.props.testID === 'reset.resetStart.s2.local-1.pick')!;
    expect(screen.findByTestId('reset.resetStart.s2.local-1.open')!.props.disabled).toBe(true);
    await act(async () => {
      unavailable.props.onSelect(unavailable.props.items[0].id);
      await Promise.resolve();
    });
    expect(requests()).toEqual([]);
    await act(async () => {
      available.props.onSelect(available.props.items[0].id);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]!.actionId).toBe('session.pending.resetStart.set');
    expect(requests()[0]!.actionArgs).toEqual({
      sessionId: 's1', localId: 'local-1', serverId: server.id,
      reset: { source: reads[0]!.source, recordId: reads[0]!.current!.recordId, meterId: 'weekly', witness: { id: 'accepted-work', observedAtMs: now } },
    });
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
  const label = fit.findHostByTestId('fit.plan.work.fit')!.props
    .accessibilityLabel as string;
  expect(label).toContain('1');
  expect(label).toContain('3');
  expect(fit.findByTestId('fit.plan.other.fit.insufficient')).toBeTruthy();
  expect(fit.findByTestId('fit.notRecorded')).toBeTruthy();
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
    expect(screen.findHostByTestId('fit.plan.work')!.props.accessibilityLabel).toContain(expected);
  } finally {
    setPreferredLanguageFromSettings(previousLanguage);
  }
});


it.each(['waiting', 'unbound'] as const)('conceals hidden reset-plan Session labels while keeping configured %s work', async kind => {
  const now = Date.now();
  const { server, credentials } = await serveResetStartApprovalHome('https://usage-reset-privacy.test');
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
