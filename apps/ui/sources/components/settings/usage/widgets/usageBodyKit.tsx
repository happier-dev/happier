import { usageProjectDisplayKey } from './usageWorkPresentation';
import * as React from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { UsageAccountingMetricSchema, type UsageAccountingMetric, type UsageHistoryReadState, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import {
  canRetryUsageCoverageFailure, isUsageCoverageFailure, isUsageQuotaOwnershipUnproven, needsNewerServer,
  usagePageReadFamily, usageScopeRefusalCode,
} from '@/sync/api/account/usageReadFailure';
export { canRetryUsageCoverageFailure, isUsageCoverageFailure, isUsageQuotaOwnershipUnproven } from '@/sync/api/account/usageReadFailure';
import {
  readUsageAccountingReadAtMs,
  readUsageOldestAccountingObservation,
  type UsageQueryResultSlice,
  type UsageQuerySourceState,
} from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { HAPPIER_FRESHNESS_LINE_METRICS, HappierListOverflowFooter, HappierSkeletonBlock, USAGE_METER_METRICS, USAGE_SUMMARY_STAT_BASIS_PX, leadHappierListRows } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useDeviceType } from '@/utils/platform/responsive';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { WidgetFrameBodyRowsContext, useWidgetBodyRowHeight } from '@/components/widgets/frame/widgetFrameBody';
import type { SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useRegisterUsageBodyReadingPlaceholder } from './usageBodyHeightMemory';
import {
  buildUsageAnalyticsViewModel,
  resolveResponseDayStreaks,
  type UsageAnalyticsViewModel,
} from '@/sync/api/account/usageAnalytics';
import { getPreferredLanguage, t, type TranslationKeyNoParams } from '@/text';
import { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { type UsagePageCostProjection} from '@happier-dev/protocol/usage/usageCostFacts';
import { type UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { formatUsageCalendarPeriod, formatUsageObservedAt, isUsageObservationFromEarlierDay } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageSourceTitle } from '@/sync/domains/usage/usageLabels';
import { getUsageHistoryReadOperation } from '@/sync/api/account/usageHistoryReadState';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
export { usageSourceTitle, usageAgentTitle, usageDimensionLabel } from '@/sync/domains/usage/usageLabels';
import { useUsageWidgetPageHasCoverageDetail, useUsageWidgetPageNothingRecorded } from './usageWidgetBatch';
import { useShallow } from 'zustand/react/shallow';
import { useProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { useAllMachines } from '@/sync/domains/state/storage';
import { useSessionListRowsByServerId, useSessionSelector, type SessionListRowChanges } from '@/sync/store/hooks';
import { isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { selectProjectChoiceMachineNames } from '@/sync/domains/machines/identity/projectChoiceMachineNames';
import { createProjectAnchorOfKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { projectUsageOptionFacts, resolveUsageProjectTitles } from '@happier-dev/protocol/usage/usageFilterOptions';
import { useUsageDisclosureCommand, useUsageRetryCommand, type UsageRetryRead } from './usageMountedControls';
import { isWidgetResourceQuietRefresh } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readUsageSourceStates } from './usageSourceSelection';

const EMPTY_USAGE_SESSION_ROWS: Readonly<Record<string, SessionListRenderableSession>> = Object.freeze({});

/** Usage labels follow only the Session rows referenced by the admitted facts on this Home. */
export function useUsageSessionRows(serverId: string, sessionIds: readonly string[]) {
  const select = React.useMemo(() => {
    const demanded = new Set(sessionIds);
    let selected = EMPTY_USAGE_SESSION_ROWS;
    return (rows: SessionListRowStateByServerId, changes: SessionListRowChanges | null) => {
      const bucket = rows[serverId];
      // Home retirement can remove the whole bucket, including row-only reads.
      if (!bucket) return (selected = EMPTY_USAGE_SESSION_ROWS);
      if (changes) {
        let intersects = false;
        for (const id of changes.sessionIds) {
          if (!demanded.has(id)) continue;
          intersects = true;
          break;
        }
        if (!intersects) return selected;
      }
      const next: Record<string, SessionListRenderableSession> = {};
      for (const id of demanded) {
        const row = bucket[id];
        if (row) next[id] = row;
      }
      selected = next;
      return selected;
    };
  }, [serverId, sessionIds]);
  return useSessionListRowsByServerId(sessionIds.length > 0 ? [serverId] : [], select);
}

/** What every Usage body receives from the one dispatcher: admitted facts, never a fetch handle. */
export type UsageBodyProps = Readonly<{
  id: UsageBuiltinWidgetIdV1;
  model: Pick<UsageWidgetBodyModel, 'refresh'>;
  slice: UsageQueryResultSlice;
  /** The query these facts answer (the shown one while a period change settles). */
  query: UsageQuery;
  serverId: string;
  testID: string;
  /** The placed widget's own presentation inputs (Style, Colour by, day); descriptor-owned, never query scope. */
  presentation?: UsageWidgetPresentationInputs;
}>;

export type UsageWidgetPresentationInputs = Readonly<{ style?: string; colourBy?: string; day?: string }>;

export function useUsagePluginTheme(): PluginUiThemeV1 {
  const { theme } = useUnistyles();
  return usePluginUiTheme(theme);
}

/**
 * The Session whose own usage page hosts these bodies (the route's Session), decided once by the page. A Session filter
 * on a query is not that fact: a Session-pinned widget can sit on the Account Work view (J-B58).
 */
const UsageSessionPageHostContext = React.createContext<string | null>(null);

export function UsageSessionPageHost(props: Readonly<{ value: string | null; children: React.ReactNode }>) {
  return <UsageSessionPageHostContext.Provider value={props.value}>{props.children}</UsageSessionPageHostContext.Provider>;
}

export function useUsageSessionPageHost(): string | null {
  return React.useContext(UsageSessionPageHostContext);
}

/** The one Session a query reads, when it reads exactly one. */
export function usageQuerySingleSession(query: Partial<Pick<UsageQuery, 'session'>>): string | null {
  return typeof query.session === 'string' ? query.session : query.session?.length === 1 ? query.session[0]! : null;
}

/**
 * Whether the viewer was given access to this Session rather than owning it: their figures are their own account's
 * usage in it, never the Session's. Decided once, by the access owner, for the page header and the Session bodies.
 */
export function useUsageSessionRecipient(sessionId: string | null, serverId: string | null | undefined): boolean {
  return useSessionSelector(sessionId ?? '', serverId,
    session => sessionId !== null && session !== null && isSessionAccessRecipient(session.access, session.accessLevel));
}

/**
 * Exact shown dates; a date range does not establish a rolling preset identity. `viewerOwn`: the viewer was given
 * access to this one Session, so its figures are "Your usage", not the Session's (acceptance r226 #62).
 */
export function usagePeriodPhrase(query: Pick<UsageQuery, 'period' | 'timeZoneOffsetMinutes'> & Partial<Pick<UsageQuery, 'session'>>,
  options?: Readonly<{ viewerOwn?: boolean }>): string {
  // One Session read over its whole life: the period is the Session itself.
  const oneSession = typeof query.session === 'string' || (Array.isArray(query.session) && query.session.length === 1);
  const sessionLabel = t(options?.viewerOwn ? 'usage.board.page.sessionRecipientFigure' : 'usage.board.page.thisSession');
  if (oneSession && 'relative' in query.period && query.period.relative === 'all') return sessionLabel;
  const period = formatUsageCalendarPeriod({ ...query.period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes });
  return oneSession ? `${sessionLabel} · ${period}` : period;
}

// One projection per admitted accounting response and presentation; bodies share it, never rebuild it.
type UsageBodyAnalyticsView = UsageAnalyticsViewModel & Readonly<{ pageCost: UsagePageCostProjection; metric: UsageAccountingMetric }>;
const viewModels = new WeakMap<object, Map<string, UsageBodyAnalyticsView | number | null>>();

function usageBodyProjections(accounting: object) {
  let byKey = viewModels.get(accounting);
  if (!byKey) {
    byKey = new Map();
    viewModels.set(accounting, byKey);
  }
  return byKey;
}

/** Keep the analytics input, not the read's history/provenance envelope. Coverage
 * is rendered from the live slice; only ranking and calendar streaks consume it
 * inside the analytics/cost projection. Other response members retain the
 * aggregation owner's value-equal references. No second model cache is needed.
 */
function usageAnalyticsInput(accounting: UsageQueryResultSlice['accounting'], key: keyof NonNullable<UsageQueryResultSlice['accounting']>): unknown {
  const descriptor = accounting && Object.getOwnPropertyDescriptor(accounting, key);
  // Lazy members depend on their getter, not on a value read eagerly just to
  // decide whether a model is needed. Ordinary validated JSON uses its value.
  return descriptor?.get ?? descriptor?.value;
}

function useUsageAnalyticsAccounting(accounting: UsageQueryResultSlice['accounting'], timeZoneOffsetMinutes = 0) {
  const dayStreaks = React.useMemo(() => accounting?.activity?.calendarDays
    ? resolveResponseDayStreaks(accounting, timeZoneOffsetMinutes) : null, [
    accounting?.activity?.calendarDays, accounting?.coverage?.range, accounting?.coverage?.status,
    accounting?.insights, timeZoneOffsetMinutes,
  ]);
  return React.useMemo(() => accounting, [
    usageAnalyticsInput(accounting, 'totals'), usageAnalyticsInput(accounting, 'tokenCategories'), usageAnalyticsInput(accounting, 'costPresentation'),
    usageAnalyticsInput(accounting, 'activity'), usageAnalyticsInput(accounting, 'insights'), usageAnalyticsInput(accounting, 'leaders'),
    usageAnalyticsInput(accounting, 'series'), usageAnalyticsInput(accounting, 'modelTimeline'), usageAnalyticsInput(accounting, 'engineTimeline'),
    usageAnalyticsInput(accounting, 'breakdowns'), usageAnalyticsInput(accounting, 'messageStats'), usageAnalyticsInput(accounting, 'contributions'),
    usageAnalyticsInput(accounting, 'costFacts'),
    accounting?.coverage?.status, accounting?.coverage?.reasons, accounting?.coverage?.ranked,
    dayStreaks?.activeDays, dayStreaks?.currentStreakDays, dayStreaks?.longestStreakDays,
  ]);
}

/**
 * The Project a usage key belongs to now (`createProjectAnchorOfKeyV1`, owner 11-08): usage a checkout was stamped
 * with before it joined a Project counts under that Project. Only joined checkouts change a key's Project, so
 * `joinedKey` (a cache key) and `resolve` stay put through an unrelated census refresh.
 */
export function useUsageProjectAnchorOf(serverId: string): Readonly<{ joinedKey: string; resolve: (key: string) => string }> {
  const selectJoinedKey = React.useMemo(() => {
    let previousRefs: ProjectAccountRowsSnapshot['workspaceRefs'] | undefined;
    let key = '[]';
    return (rows: ProjectAccountRowsSnapshot | null) => {
      const refs = rows?.workspaceRefs;
      if (refs === previousRefs) return key;
      previousRefs = refs;
      key = JSON.stringify((refs ?? []).filter(ref => ref.projectKey !== undefined && ref.projectKey !== ref.id)
        .map(ref => [ref.serverId, ref.id, ref.projectKey]).sort());
      return key;
    };
  }, []);
  const joinedKey = useProjectAccountRows(selectJoinedKey);
  return React.useMemo(() => {
    const joined = (JSON.parse(joinedKey) as Array<[string, string, string]>).map(([refServerId, id, projectKey]) => ({
      id, serverId: refServerId, projectKey, machineId: '', rootPath: '', createdAtMs: 0 }));
    const anchorOf = createProjectAnchorOfKeyV1(joined, { normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    return { joinedKey, resolve: (key: string) => anchorOf(serverId, key) };
  }, [joinedKey, serverId]);
}

type UsageProjectNameFact = Readonly<{ key: string; label?: string; machineIds?: readonly string[] }>;
const NO_PROJECT_NAME_FACTS: readonly UsageProjectNameFact[] = [];

export function useUsageProjectOptionFacts(serverId: string, enabled = true) {
  const rows = useProjectAccountRows(useShallow(rows => {
    if (!rows || rows.status === 'locked' || rows.status === 'refused'
      || !areServerProfileIdentifiersEquivalent(rows.scope.serverId, serverId)) return undefined;
    return { workspaceRefs: rows.workspaceRefs, organizations: rows.organizations };
  }), enabled);
  return React.useMemo(() => {
    if (!rows) return undefined;
    const { projectGroups, hiddenProjectGroups } = projectProjectListV1({ serverId, workspaceRefs: rows.workspaceRefs,
      organizations: rows.organizations, normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    return projectUsageOptionFacts([...projectGroups, ...hiddenProjectGroups], rows.organizations);
  }, [rows, serverId]);
}

export function useUsageProjectChoiceMachineNames(enabled = true) {
  return useAllMachines(React.useCallback(machines => enabled
    ? Object.fromEntries(selectProjectChoiceMachineNames(machines)) : {}, [enabled]));
}

/** Names and checkout context stay in the opened Account projection; accounting carries Project anchors. */
export function useUsageProjectNames(serverId: string, fallbacks: readonly UsageProjectNameFact[] = NO_PROJECT_NAME_FACTS): Readonly<{
  labels: ReadonlyMap<string, string>;
  machineIds: ReadonlyMap<string, readonly string[]>;
  label: (key: string | null) => string;
  displayKey: (key: string | null) => string | null;
}> {
  const projectFacts = useUsageProjectOptionFacts(serverId);
  const machineNames = useUsageProjectChoiceMachineNames();
  return React.useMemo(() => {
    const titles = resolveUsageProjectTitles(new Map(fallbacks.map(row => [row.key, row.label ?? row.key])),
      { projectFacts, machineNames });
    const labels = new Map<string, string>();
    for (const [key, title] of titles) if (title !== null) labels.set(key, title);
    const machineIds = new Map<string, readonly string[]>();
    for (const row of fallbacks) if (row.machineIds) machineIds.set(row.key, row.machineIds);
    for (const [key, fact] of projectFacts ?? []) {
      if (fact.machineIds) machineIds.set(key, [...new Set([...(machineIds.get(key) ?? []), ...fact.machineIds])]);
    }
    return { labels, machineIds, displayKey: (key: string | null) => usageProjectDisplayKey(key, labels),
      label: (key: string | null) => key === null
      ? t('usage.board.work.unknownProject') : labels.get(key) ?? t('usage.board.work.unknownProject') };
  }, [projectFacts, machineNames, fallbacks]);
}

/** Preserve the Machine owner's collision-aware names wherever Work/Project context is shown. */
export function usageMachinePlace(ids: readonly string[], machineNames: Readonly<Record<string, string>>): string {
  const names = [...new Set(ids.map(id => machineNames[id]).filter((name): name is string => name !== undefined))];
  return names.length > 2 ? t('usage.board.page.machinesCount', { count: names.length }) : names.join(', ');
}

/** The incumbent UI projection of A facts for this slice (A owns the numbers, this only shapes them). */
export function useUsageAnalyticsView(
  slice: UsageQueryResultSlice,
  query: UsageQuery,
): UsageBodyAnalyticsView | null {
  const accounting = useUsageAnalyticsAccounting(slice.accounting, query.timeZoneOffsetMinutes ?? 0);
  const language = getPreferredLanguage();
  const key = `${query.metric}\u0000${query.costBasis}\u0000${query.timeZoneOffsetMinutes ?? 0}\u0000${language}`;
  const view = React.useMemo(() => {
    if (!accounting) return null;
    const metric = UsageAccountingMetricSchema.safeParse(query.metric);
    if (!metric.success) return null;
    const byKey = usageBodyProjections(accounting);
    const cached = byKey.get(key);
    if (cached !== null && typeof cached === 'object') return cached;
    const analytics = buildUsageAnalyticsViewModel(
      accounting,
      // The response already carries the admitted range; the legacy array filter is unused here.
      { period: 'all', metric: metric.data, costMode: query.costBasis, focus: null },
      query.timeZoneOffsetMinutes ?? 0,
    );
    // The admitted-response model supplies pageCost. Keep its lazy section getters intact:
    // spreading the model would evaluate every section before the body reads one.
    const built = Object.assign(analytics, { metric: metric.data }) as UsageBodyAnalyticsView;
    byKey.set(key, built);
    return built;
  }, [
    accounting,
    query.metric,
    query.costBasis,
    query.timeZoneOffsetMinutes,
    language,
  ]);
  // A later remount sees the latest admitted envelope. Let it share the same
  // retained model through the incumbent response cache as mounted readers do.
  if (view && slice.accounting && slice.accounting !== accounting) {
    usageBodyProjections(slice.accounting).set(key, view);
  }
  return view;
}

/** Comparison bodies share the same admitted-response projection owner as current facts. */
export function useUsageComparisonCost(
  slice: UsageQueryResultSlice,
  costBasis: UsageQuery['costBasis'],
  selection: UsagePageCostProjection['selection'] | undefined,
): number | null {
  const accounting = useUsageAnalyticsAccounting(slice.comparison?.accounting);
  const kind = selection?.kind;
  const currency = selection?.currency;
  const mode = selection?.mode;
  const key = JSON.stringify(['comparison', costBasis, kind, currency, mode]);
  const amount = React.useMemo(() => {
    if (!accounting || kind === undefined || currency === undefined) return null;
    // Selection objects can be replaced by an unrelated current-range revision;
    // only their monetary meaning affects this preceding-range projection.
    const byKey = usageBodyProjections(accounting);
    const cached = byKey.get(key);
    if (typeof cached === 'number' || cached === null) return cached;
    const amount = projectUsagePageCost(accounting, costBasis, { kind, currency, ...(mode === undefined ? {} : { mode }) }).amountUsd;
    byKey.set(key, amount);
    return amount;
  }, [accounting, costBasis, kind, currency, mode]);
  if (slice.comparison?.accounting && slice.comparison.accounting !== accounting) {
    usageBodyProjections(slice.comparison.accounting).set(key, amount);
  }
  return amount;
}

/**
 * A supported, visible result for a fact this query cannot answer yet. It says what is missing and
 * why; it never draws zero.
 */
/** A skeleton bar centred in the line it stands for, so a body's skeleton holds its settled rows' heights. */
function SkeletonLine(props: Readonly<React.ComponentProps<typeof HappierSkeletonBlock> & { slotHeight: number }>) {
  const { slotHeight, ...block } = props;
  return <View style={{ height: slotHeight, justifyContent: 'center' }}><HappierSkeletonBlock {...block} /></View>;
}

/**
 * A first read that has not answered yet holds the body's room with the shared skeleton, in the shape of
 * what lands (a figure, its meter, a caption line); it never reads as "none" (lab kitstates "Loading ·
 * first time"). The page header already says what is still being read.
 */
export function UsageBodyReading(props: Readonly<{
  testID: string;
  /**
   * The body's known shape, so the room it will fill is held from the first frame: `meters` rows of a
   * name, a bar and a caption (a list of allowance windows), or the `mix` of four figures over a strip.
   */
  shape?: Readonly<{ kind: 'meters'; rows: number }> | Readonly<{ kind: 'mix' }> | Readonly<{ kind: 'summary' }> | Readonly<{ kind: 'strip' }> | Readonly<{ kind: 'capacity' }>
    /** A sized chart: its plot at the settled height, then the axis, legend and note room around it. */
    /** `peak`: the settled chart draws its peak figure above the plot, so the held room includes it. */
    | Readonly<{ kind: 'chart'; plotPx: number; peak?: boolean }>;
  /**
   * The reads this body waits on. After {@link USAGE_READING_NOTE_AFTER_MS} a body still reading says so, once,
   * in its own reserved line ("Still reading activity"), instead of holding a skeleton with no word indefinitely.
   */
  waitingOn?: Readonly<{ slice: UsageQueryResultSlice; sources: readonly string[] }>;
}>) {
  const { theme } = useUnistyles();
  // While this placeholder is up the body has no facts; its dispatch holds the room it last drew them in.
  useRegisterUsageBodyReadingPlaceholder();
  const reducedMotion = useReducedMotionPreference();
  const color = theme.colors.surface.skeleton;
  const shape = props.shape;
  // A body narrower than this (a phone) wraps the cost figure's caption onto a second line.
  const bodyWidth = useWidgetPresentation()?.geometry?.width;
  const narrow = bodyWidth !== undefined && bodyWidth < NARROW_BODY_PX;
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const note = useUsageReadingNote(props.waitingOn);
  const noteLine = props.waitingOn ? (
    <View testID={`${props.testID}.note`} style={readingStyles.noteSlot}>
      {note ? <SurfaceFreshnessLine testID={`${props.testID}.noteLine`} busy reason={note} /> : null}
    </View>
  ) : null;
  if (shape?.kind === 'chart') {
    // Bars standing on the plot's floor at the settled plot height, then the axis and legend lines; the room
    // under them is the chart's own chrome, so the settled chart lands without moving anything below.
    const chrome = resolveUsageChartChromePx(bodyWidth, { peak: shape.peak === true });
    return (
      <View testID={props.testID} style={{ minHeight: shape.plotPx + chrome }}>
        <View testID={`${props.testID}.plot`} style={{ height: shape.plotPx }}>
          <View style={readingStyles.chartBars}>
            {USAGE_READING_CHART_BARS.map((share, index) => (
              <View key={index} style={readingStyles.chartBar}>
                <HappierSkeletonBlock color={color} width="100%" height={Math.max(8, Math.round(shape.plotPx * share))} radius={3} reducedMotion={reducedMotion} />
              </View>
            ))}
          </View>
        </View>
        <View style={readingStyles.chartChrome}>
          <SkeletonLine color={color} width="100%" height={1} radius={0} reducedMotion={reducedMotion} slotHeight={14} />
          <SkeletonLine color={color} width="42%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={18} />
          {noteLine}
        </View>
      </View>
    );
  }
  if (shape?.kind === 'meters') {
    return (
      <View testID={props.testID} style={readingStyles.meters}>
        {Array.from({ length: Math.max(1, shape.rows) }, (_, index) => (
          <View key={index} style={readingStyles.meter}>
            <HappierSkeletonBlock color={color} width="46%" height={12} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="100%" height={6} radius={3} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="22%" height={10} radius={4} reducedMotion={reducedMotion} />
          </View>
        ))}
      </View>
    );
  }
  if (shape?.kind === 'mix') {
    // Each figure holds its settled rows (label, figure, captions; the cost figure also its comparison line).
    const lines = (count: number) => <View>{Array.from({ length: count }, (_, line) => <SkeletonLine key={line} color={color} width={line === 0 ? '70%' : '40%'} height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} />)}</View>;
    return (
      <View testID={props.testID} style={readingStyles.mix}>
        <View style={readingStyles.mixFigures}>
          {[0, 1, 2, 3].map((index) => (
            <View key={index} style={readingStyles.mixFigure}>
              <SkeletonLine color={color} width="50%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} />
              <SkeletonLine color={color} width="38%" height={22} radius={6} reducedMotion={reducedMotion} slotHeight={28} />
              {index === 1 ? <SkeletonLine color={color} width="46%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} /> : null}
              {lines(index === 1 && narrow ? 2 : 1)}
            </View>
          ))}
        </View>
        <View style={readingStyles.mixStrip}>
          <HappierSkeletonBlock color={color} width="100%" height={14} radius={5} reducedMotion={reducedMotion} />
          <HappierSkeletonBlock color={color} width="60%" height={10} radius={4} reducedMotion={reducedMotion} />
        </View>
      </View>
    );
  }
  if (shape?.kind === 'capacity') {
    // Capacity's settled rows, so its first read does not grow into them: the headline's figure and line, a
    // row of account cells (name, meter, figure), one pool line and, on a host without the Sources detail,
    // the freshness line's room.
    return (
      <View testID={props.testID} style={readingStyles.capacity}>
        <View style={readingStyles.capacityHero}>
          <SkeletonLine color={color} width={84} height={35} radius={8} reducedMotion={reducedMotion} slotHeight={50} />
          <SkeletonLine color={color} width="44%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={16} />
        </View>
        <View style={readingStyles.capacityCells}>
          {[0, 1, 2].map((index) => (
            <View key={index} style={readingStyles.capacityCell}>
              <HappierSkeletonBlock color={color} width="100%" height={6} radius={3} reducedMotion={reducedMotion} />
              <HappierSkeletonBlock color={color} width="62%" height={12} radius={4} reducedMotion={reducedMotion} />
              <HappierSkeletonBlock color={color} width="38%" height={10} radius={4} reducedMotion={reducedMotion} />
            </View>
          ))}
        </View>
        <SkeletonLine color={color} width="36%" height={12} radius={4} reducedMotion={reducedMotion} slotHeight={SETTLED_QUIET_LINE_PX} />
        {pageHasDetail ? null : <View style={{ minHeight: HAPPIER_FRESHNESS_LINE_METRICS.minHeightPx }} />}
      </View>
    );
  }
  if (shape?.kind === 'strip') {
    return (
      <View testID={props.testID} style={readingStyles.strip}>
        {[0, 1, 2].map((index) => (
          <View key={index} style={readingStyles.stripColumn}>
            <HappierSkeletonBlock color={color} width="34%" height={10} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="86%" height={14} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="100%" height={10} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="62%" height={10} radius={4} reducedMotion={reducedMotion} />
          </View>
        ))}
      </View>
    );
  }
  if (shape?.kind === 'summary') {
    // The same rows as the settled summary: the figure's line, its comparison line, and three figures of
    // label, figure and caption (the money figure's caption takes two lines in a narrow body).
    return (
      <View testID={props.testID} style={readingStyles.summary}>
        <View style={readingStyles.summaryHero}>
          <SkeletonLine color={color} width="34%" height={34} radius={8} reducedMotion={reducedMotion} slotHeight={50} />
          <SkeletonLine color={color} width="52%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} />
        </View>
        <View style={readingStyles.summaryStats}>
          {[0, 1, 2].map((index) => (
            <View key={index} style={readingStyles.summaryStat}>
              <SkeletonLine color={color} width="40%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} />
              <SkeletonLine color={color} width="62%" height={22} radius={6} reducedMotion={reducedMotion} slotHeight={28} />
              <View>
                <SkeletonLine color={color} width="84%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} />
                {index === 0 && narrow ? <SkeletonLine color={color} width="50%" height={10} radius={4} reducedMotion={reducedMotion} slotHeight={14} /> : null}
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={readingStyles.body}>
      <HappierSkeletonBlock color={color} width="28%" height={28} radius={6} reducedMotion={reducedMotion} />
      <HappierSkeletonBlock color={color} width="100%" height={8} radius={4} reducedMotion={reducedMotion} />
      <HappierSkeletonBlock color={color} width="56%" height={12} radius={4} reducedMotion={reducedMotion} />
      {noteLine}
    </View>
  );
}

/** Below this body width the cost figure's caption ("estimated where not reported") wraps to two lines. */
const NARROW_BODY_PX = 360;
/**
 * How long a first read may hold a bare skeleton before its body says what it is still reading. A skeleton
 * reads as "arriving" for a few seconds; past that, a silent one reads as stuck. The read itself is not cut.
 */
export const USAGE_READING_NOTE_AFTER_MS = 15_000;
/** The reading chart's bar profile (share of the plot), a calm uneven skyline rather than a flat block. */
const USAGE_READING_CHART_BARS = [0.34, 0.52, 0.41, 0.66, 0.48, 0.3, 0.58, 0.72, 0.44, 0.38, 0.6, 0.5, 0.28, 0.46] as const;

/** Which of a body's reads are still outstanding, named by read family once the wait has run past its bound. */
function useUsageReadingNote(waitingOn: Readonly<{ slice: UsageQueryResultSlice; sources: readonly string[] }> | undefined): string | null {
  const [late, setLate] = React.useState(false);
  const waiting = waitingOn !== undefined;
  React.useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setLate(true), USAGE_READING_NOTE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  if (!late || !waitingOn) return null;
  const names = [...new Set(readUsageCoverageGaps(waitingOn.slice, waitingOn.sources)
    .filter(gap => gap.status === 'pending' || gap.status === 'not_loaded')
    .map(gap => usageSourceTitle(usagePageReadFamily(gap.source))))];
  return names.length ? t('usage.board.page.coveragePending', { sources: names.join(', ') }) : null;
}
/** The Coach's Overview strip with its findings in (one row of three columns) measures this tall. */
export const SETTLED_COACH_STRIP_BODY_PX = 118;
const readingStyles = StyleSheet.create(() => ({
  body: { gap: 12, paddingVertical: 4 },
  meters: { gap: USAGE_METER_METRICS.rowGapPx, paddingVertical: 4 },
  meter: { gap: 8 },
  mix: { gap: 18 },
  // The token mix's strip and its legend line, as the settled body draws them.
  mixStrip: { height: 40, gap: 14 },
  // The Efficiency card's four figures wrap two-up exactly as the figures themselves do (UsageEfficiencyWidget).
  mixFigures: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 16 },
  mixFigure: { flexGrow: 1, flexBasis: '40%', minWidth: 120, gap: 2 },
  // The Period summary's settled rows: a hero line, its comparison line, and three captioned figures.
  summary: { gap: 20 },
  summaryHero: { gap: 2 },
  // The same wrap as the figures themselves (UsagePeriodSummaryWidget), so a narrow card holds two rows too.
  summaryStats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 16 },
  summaryStat: { flexGrow: 1, flexBasis: USAGE_SUMMARY_STAT_BASIS_PX, minWidth: 0, gap: 2 },
  // The Capacity body's gap, and the cells row's settled height (measured on Home: figure 70, cells 104, pool line 18).
  capacity: { gap: 18 },
  capacityHero: { gap: 4 },
  capacityCells: { height: 104, flexDirection: 'row', columnGap: 12 },
  capacityCell: { flex: 1, minWidth: 0, gap: 12, justifyContent: 'center' },
  strip: { minHeight: SETTLED_COACH_STRIP_BODY_PX, flexDirection: 'row', columnGap: 36, paddingVertical: 4 },
  chartBars: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', columnGap: 6 },
  chartBar: { flex: 1, minWidth: 0 },
  chartChrome: { paddingTop: 4 },
  // The note's line is held from the first frame, so saying it moves nothing.
  noteSlot: { minHeight: HAPPIER_FRESHNESS_LINE_METRICS.minHeightPx, justifyContent: 'center' },
  stripColumn: { flex: 1, gap: 10 },
}));

/** True while every read a body depends on is still outstanding (pending or not yet loaded). */
/**
 * The room a sized usage chart's frame keeps around its plot: the axis, the legend and a one-line coverage
 * note (`chrome`), plus the peak figure's room when the chart draws one (`peak`, StackedSeriesChart's
 * `showPeakValue`). Below `narrowFramePx` (a Board's Medium card, a rail) the legend's "Show all" wraps onto a
 * second line (`narrowChrome`), which the plot leaves room for, so the coverage note is never cut by the frame.
 * Daily usage and Usage flow share the anatomy and this one rule; only Daily draws the peak.
 */
export const USAGE_CHART_FRAME_PX = Object.freeze({ chrome: 84, narrowFrame: 420, narrowChrome: 20, peak: 32, plot: 252 });

/**
 * A sized chart's plot height: what its frame leaves after the chrome, never more than its declared plot
 * (`plot`, lab wgusage-CD) and never less than `minPx`. A grown or content-height cell tells the body its own
 * box, so without the ceiling the plot would follow every pixel it was given; with it, a tall cell keeps the
 * chart's height and leaves the rest of its space empty. `minPx` must itself fit the cell, or the floor pushes
 * the footer past the frame's edge.
 */
export function resolveUsageChartPlotPx(
  geometry: Readonly<{ width: number; height: number }> | undefined,
  minPx: number,
  options?: Readonly<{ peak?: boolean }>,
): number {
  const chrome = resolveUsageChartChromePx(geometry?.width, options);
  return Math.max(minPx, Math.min(USAGE_CHART_FRAME_PX.plot, (geometry?.height ?? USAGE_CHART_FRAME_PX.plot + chrome) - chrome));
}

/**
 * The room a Usage chart's frame declares for its body (its footprint's rows × the body row height), known in the
 * first frame. A phone stacks bodies at their content's height and declares no room; outside a frame there is none.
 */
export function useUsageChartRoomPx(): number | undefined {
  const rows = React.useContext(WidgetFrameBodyRowsContext);
  const rowHeight = useWidgetBodyRowHeight();
  const phone = useDeviceType() === 'phone';
  return phone || !rows ? undefined : rows * rowHeight;
}

/**
 * Every Usage chart's plot height, decided once before its first paint (sweep 1110 #8–#10): the declared room less
 * the chart's chrome, or `minPx` on a phone, where no room is declared. Never the body's own measured box: a box
 * that holds the chart feeds the chart's height back into itself, and the plot then relays out after it draws.
 * A body whose frame declares no rows (a fixed viewport, a host outside the grouped area) is told its container's
 * size, which its content cannot change, so that geometry stands.
 */
export function useUsageChartPlotPx(minPx: number, options?: Readonly<{ peak?: boolean }>): number {
  const geometry = useWidgetPresentation()?.geometry;
  const room = useUsageChartRoomPx();
  const phone = useDeviceType() === 'phone';
  if (phone) return minPx;
  return resolveUsageChartPlotPx(room === undefined ? geometry
    : { width: geometry?.width ?? USAGE_CHART_FRAME_PX.narrowFrame, height: room }, minPx, options);
}

export function resolveUsageChartChromePx(frameWidth: number | undefined, options?: Readonly<{ peak?: boolean }>): number {
  const width = frameWidth ?? USAGE_CHART_FRAME_PX.narrowFrame;
  return USAGE_CHART_FRAME_PX.chrome
    + (width < USAGE_CHART_FRAME_PX.narrowFrame ? USAGE_CHART_FRAME_PX.narrowChrome : 0)
    + (options?.peak ? USAGE_CHART_FRAME_PX.peak : 0);
}

export function isUsageReadOutstanding(slice: UsageQueryResultSlice, sources: readonly string[]): boolean {
  const gaps = readUsageCoverageGaps(slice, sources);
  return gaps.length > 0 && gaps.every(gap => gap.status === 'pending' || gap.status === 'not_loaded');
}

const USAGE_ACCOUNTING_SOURCES = ['accounting'] as const;

/** "No usage in this period" only once the usage read answered; until then the body is loading. */
export function UsageBodyNoUsage(props: Readonly<{
  slice: UsageQueryResultSlice;
  testID: string;
  onRetry: UsageRetryRead;
  /** The shape the body will take, so its first read holds that room. */
  readingShape?: React.ComponentProps<typeof UsageBodyReading>['shape'];
}>) {
  if (isUsageReadOutstanding(props.slice, ['accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: USAGE_ACCOUNTING_SOURCES }} {...(props.readingShape ? { shape: props.readingShape } : {})} />;
  if (!props.slice.accounting)
    return <UsageBodyReadFailed slice={props.slice} sources={USAGE_ACCOUNTING_SOURCES} testID={props.testID} onRetry={props.onRetry} />;
  return <UsageBodyNoUsageSettled testID={props.testID} />;
}

function UsageBodyNoUsageSettled(props: Readonly<{ testID: string }>) {
  // The page already said "No usage in this period" and its next step: this card only holds its quiet line.
  if (useUsageWidgetPageNothingRecorded()) return <UsageBodyNothingYet testID={props.testID} />;
  return (
    <UsageBodyInsufficient
      testID={`${props.testID}.empty`}
      title={t('usage.board.page.noUsageTitle')}
      reason={t('usage.board.page.noUsageReason')}
    />
  );
}

/**
 * A body on a Usage page whose period recorded nothing: the page header says the cause once, with Start a session
 * (`readUsagePageNothingRecorded`), so each card is one quiet line rather than the same sentence again (C first use).
 */
export function UsageBodyNothingYet(props: Readonly<{ testID: string }>) {
  return (
    <SurfaceStateCard
      testID={`${props.testID}.nothingYet`}
      kind="empty"
      layout="inline"
      size="line"
      replacesContent={false}
      title={t('usage.board.page.nothingYetTitle')}
    />
  );
}

/**
 * Whether a settled body has nothing to draw because one of its reads failed: what it would show is
 * unknown, never zero, so it says it was not read instead of its empty state. A read this Home's server is
 * too old for is its own fact (`readUsageSourceNeedsNewerServer`), not a failure.
 */
export function isUsageReadFailed(slice: UsageQueryResultSlice, sources: readonly string[]): boolean {
  if (isUsageReadOutstanding(slice, sources)) return false;
  if (sources.includes('accounting') && !slice.accounting) return true;
  return readUsageCoverageGaps(slice, sources).some(gap => gap.status === 'error' && !needsNewerServer(gap));
}

/**
 * A body whose read failed. On the Usage page the header says a failed page read once, with its Retry, so
 * the body only says it was not read. Elsewhere (Home, a Project), or for the widget's own read, the
 * widget says the cause and offers Retry itself.
 */
export function UsageBodyReadFailed(props: Readonly<{
  testID: string;
  onRetry: UsageRetryRead;
}> & (Readonly<{ slice: UsageQueryResultSlice; sources: readonly string[] }>
  | Readonly<{ errorCode: string }>)) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const resourceFailure = 'errorCode' in props;
  const gaps = resourceFailure ? [] : readUsageCoverageGaps(props.slice, props.sources);
  const failed = resourceFailure || gaps.some(gap => gap.status === 'error');
  const hidden = pageHasDetail && failed && !resourceFailure && usageCoverageLineMode(gaps, true) === 'hidden';
  const visibleGaps = pageHasDetail ? gaps.filter(gap => !isUsagePageReadSource(gap)) : gaps;
  const refusal = readUsageScopeRefusal(resourceFailure
    ? [{ source: 'accounting', status: 'error', errorCode: props.errorCode }] : visibleGaps);
  const canRetry = resourceFailure ? !refusal : visibleGaps.some(canRetryUsageCoverageFailure) || gaps.length === 0;
  const retry = useUsageRetryCommand(props.onRetry, !hidden && canRetry);
  if (hidden && readUsageScopeRefusal(gaps) && !gaps.some(canRetryUsageCoverageFailure)) return null;
  if (hidden)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.notRead`}
        kind="empty"
        layout="inline"
        size="line"
        replacesContent={false}
        title={t('usage.board.page.notReadTitle')}
      />
    );
  return (
    <>
      {refusal && <UsageScopeRefusalLine testID={`${props.testID}.scopeRefused`} codes={refusal.codes} />}
      {(!refusal || canRetry) && <SurfaceStateCard
        testID={`${props.testID}.${resourceFailure ? 'error' : 'unavailable'}`}
        kind={failed ? 'error' : 'unavailable'}
        {...(pageHasDetail ? { layout: 'inline' as const, size: 'line' as const } : { replacesContent: true })}
        diagnosticCode={resourceFailure ? props.errorCode : undefined}
        title={t('usage.board.page.readFailedTitle')}
        reason={t('usage.board.page.readFailedReason')}
        {...(canRetry ? { action: { label: t('common.retry'), onPress: retry } } : {})}
      />}
    </>
  );
}

export function UsageBodyInsufficient(
  props: Readonly<{
    title: string;
    reason?: string;
    testID: string;
    /** False for an insufficient sub-section beside admitted facts. */
    replacesContent?: boolean;
    action?: Readonly<{ label: string; onPress: (callerContext?: ActionExecutorContext) => void }>;
  }>,
) {
  // Whole-body states use the frame's room. An insufficient sub-section stays at the content edge.
  const replacesContent = props.replacesContent !== false;
  const action = props.action;
  const commands = useCurrentUiContextLocalCommands(action ? [{ key: 'action', title: action.label,
    invoke: (_input, callerContext) => action.onPress(callerContext) }] : []);
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="empty"
      replacesContent={replacesContent}
      {...(replacesContent ? {} : { layout: 'inline' as const, size: 'line' as const })}
      title={props.title}
      {...(props.reason ? { reason: props.reason } : {})}
      {...(props.action
        ? {
            action: {
              label: props.action.label,
              onPress: () => { void commands.invoke('action'); },
            },
          }
        : {})}
    />
  );
}

const COVERAGE_REASON_KEYS = {
  missing_baseline: 'usage.board.page.coverageReason_missing_baseline',
  counter_discontinuity: 'usage.board.page.coverageReason_counter_discontinuity',
  ambiguous_overlap: 'usage.board.page.coverageReason_ambiguous_overlap',
  unattributed_model: 'usage.board.page.coverageReason_unattributed_model',
  unpriced_tokens: 'usage.board.page.coverageReason_unpriced_tokens',
  unknown_source: 'usage.board.page.coverageReason_unknown_source',
  incomplete_history: 'usage.board.page.coverageReason_incomplete_history',
  ranked_truncation: 'usage.board.page.coverageReason_ranked_truncation',
  unknown_token_categories: 'usage.board.page.coverageReason_unknown_token_categories',
} satisfies Record<UsageAnalyticsCoverage['reasons'][number], TranslationKeyNoParams>;

function readAdmittedAccountingGap(accounting: UsageQueryResultSlice['accounting']): 'partial' | 'unknown' | undefined {
  if (!accounting) return undefined;
  const coverage = accounting.coverage;
  if (!coverage) return 'unknown';
  if (coverage.status !== 'complete') return coverage.status;
  return !coverage.range.complete || coverage.reasons.length > 0 ? 'partial' : undefined;
}

function usageAccountingCoverageReasons(coverage: UsageAnalyticsCoverage | undefined): string[] {
  return [...new Set(coverage?.reasons ?? [])].map(reason => t(COVERAGE_REASON_KEYS[reason]));
}

/** Sources this body depends on that are not complete, worded once under the content. */
export function readUsageCoverageGaps(
  slice: UsageQueryResultSlice,
  sources: readonly string[],
): readonly UsageQuerySourceState[] {
  const accountingValue = sources.includes('accounting') ? slice.accounting : undefined;
  const accounting = accountingValue?.coverage;
  const dependent = new Set([...sources, ...(accounting?.sources.map(source => source.source) ?? [])]);
  const quotaRequested = sources.includes('quota');
  const gaps = readUsageSourceStates(slice, sources).filter(source => source.status !== 'available');
  // Comparison owns its source state beside its exact preceding query, rather
  // than in the slice's general source list. Consumers must see that same state.
  if (dependent.has('comparison') && slice.comparison && slice.comparison.source.status !== 'available')
    gaps.push(slice.comparison.source);
  // Head age alone does not describe history coverage. Keep a known history
  // gap visible without replacing pending reads or failures.
  if (quotaRequested && slice.quota?.some(read => read.history?.nextCursor != null
    || (read.pageFacts ? read.pageFacts.historyStatus !== 'complete'
      : read.unusedCapacity && read.unusedCapacity.historyStatus !== 'returned_page'))
    && !gaps.some(source => source.source === 'quota' && (source.status !== 'stale' || isUsageCoverageFailure(source)))) {
    const clocks = slice.quota.flatMap(read => read.current && wasConnectedServiceQuotaObserved(read.current)
      ? [read.current.fetchedAtMs] : []);
    gaps.push({ source: 'quota', status: 'partial', ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) });
  }
  const accountingGap = readAdmittedAccountingGap(accountingValue);
  if (accountingGap && !gaps.some(source => source.source === 'accounting')) {
    const asOfMs = accounting ? slice.sources.find(source => source.source === 'accounting')?.asOfMs : undefined;
    gaps.unshift({ source: 'accounting', status: accountingGap, ...(asOfMs === undefined ? {} : { asOfMs }) });
  }
  const unique = new Map<string, UsageQuerySourceState>();
  const severity = { available: 0, unsupported: 1, unknown: 2, stale: 3, partial: 4, not_loaded: 5, pending: 6, error: 7 };
  for (const gap of gaps) {
    const previous = unique.get(gap.source);
    if (!previous) { unique.set(gap.source, gap); continue; }
    const worst = severity[gap.status] > severity[previous.status] ? gap : previous;
    const dates = [previous.asOfMs, gap.asOfMs].filter((date): date is number => date !== undefined);
    unique.set(gap.source, { ...worst, ...(dates.length ? { asOfMs: Math.min(...dates) } : {}) });
  }
  return [...unique.values()];
}

type UsageCoverageStatus = Pick<UsageQuerySourceState, 'source' | 'status' | 'errorCode' | 'unreadSessions'>;

function isUsageWorkOffline(source: UsageQuerySourceState): boolean {
  return source.source === 'work' && source.errorCode === 'machine_offline';
}

/** A Work read that settled with evidence for part of the selection. */
function isUsageWorkSettledWithEvidence(source: UsageQuerySourceState): boolean {
  return source.source === 'work' && source.status === 'partial';
}

/**
 * Work statuses that carry a readable answer: read whole or in part, a pending replacement keeping the prior one, or
 * the prior one retained after a failed reread. Unsupported (outside a repository), failed and refused read no links.
 */
const USAGE_WORK_READABLE_STATUSES: ReadonlySet<UsageQuerySourceState['status']> = new Set(['available', 'partial', 'pending', 'stale']);

/** When the readable Work answer on screen was read: its own as-of, never accounting's (J-A35). */
export function readUsageWorkReadAsOfMs(slice: Pick<UsageQueryResultSlice, 'sources'>): number | null {
  const source = slice.sources.find(row => row.source === 'work');
  return source?.asOfMs !== undefined && USAGE_WORK_READABLE_STATUSES.has(source.status) ? source.asOfMs : null;
}

/** A settled Work answer whose Sessions failed retryably: partly read, so the header says so truly with its Retry. */
function readUsagePageWorkRetryable(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): boolean {
  return slices.some(slice => slice.sources.some(source => isUsageWorkSettledWithEvidence(source) && canRetryUsageCoverageFailure(source)));
}

export function readUsagePageWorkOffline(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): boolean {
  return slices.some(slice => slice.sources.some(source => isUsageWorkOffline(source) && !isUsageWorkSettledWithEvidence(source)));
}

function usageCoverageHeadlineKey(gaps: readonly UsageCoverageStatus[]) {
  return gaps.some(isUsageCoverageFailure) ? 'usage.board.page.coverageFailed' as const
    : gaps.some(gap => gap.status === 'partial') ? 'usage.board.page.coveragePartial' as const
      : gaps.some(gap => gap.status !== 'pending' && gap.status !== 'not_loaded') ? 'usage.board.sources.coverageUnknown' as const
        : 'usage.board.page.coveragePending' as const;
}

/** The headline names its sources, except the unknown-coverage line, which takes none. */
function formatUsageCoverageHeadline(gaps: readonly UsageCoverageStatus[], sources: string): string {
  const key = usageCoverageHeadlineKey(gaps);
  return key === 'usage.board.sources.coverageUnknown' ? t(key) : t(key, { sources });
}

/**
 * The one quiet clause a body's own line carries when its host has no Sources detail (Home, a Board): a read
 * still going or failed names its sources (a failure with its Retry); an incomplete read says only "Partial
 * history", never a paragraph of sources and reasons. The full wording is `usageCoverageDescription`.
 */
export function usageCoverageSummary(slice: UsageQueryResultSlice, sources: readonly string[]): string {
  const gaps = readUsageCoverageGaps(slice, sources);
  if (!gaps.length) return '';
  if (!gaps.some(needsNewerServer) && !gaps.some(isUsageWorkOffline)
    && usageCoverageHeadlineKey(gaps) === 'usage.board.page.coveragePartial') return usagePartialHistoryLabel();
  return usageCoverageDescription(slice, sources);
}

/** "Partial history": the whole of what a body's quiet line says about an incomplete read. */
export function usagePartialHistoryLabel(): string {
  const text = t('usage.board.page.factIncomplete');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a wide window's history read says, once, in place of the partial-history fact it explains: the Sessions
 * not read yet with Read now, a running read's progress with Cancel, or the Sessions it couldn't read with Retry.
 * Nothing once every Session was read. `operation` is the history Action operation its control runs.
 */
export function describeUsageHistoryRead(state: UsageHistoryReadState | null): Readonly<{
  text: string;
  label: string;
  operation: 'read' | 'cancel';
  /** A settled read failed and can be retried, independently of the unread count. */
  failed: boolean;
}> | null {
  const operation = getUsageHistoryReadOperation(state);
  if (!state || !operation) return null;
  const { notRead, completed, failed } = state.progress;
  if (operation === 'cancel')
    return { text: t('usage.board.page.historyReading', { done: formatExactCount(completed), total: formatExactCount(completed + notRead) }), label: t('common.cancel'), operation: 'cancel', failed: false };
  if (operation === 'retry')
    return { text: failed > 0 ? t('usage.board.page.historyFailed', { count: formatExactCount(failed) })
      : t('usage.board.page.coverageFailed', { sources: usageSourceTitle('how_you_work') }),
      label: t('common.retry'), operation: 'read', failed: true };
  return { text: t('usage.board.page.historyNotRead', { count: formatExactCount(notRead) }), label: t('usage.board.page.historyReadNow'), operation: 'read', failed: false };
}

/**
 * A failed read this Home's server is too old to answer (a typed `update_required` for the server). It is not a
 * failure to retry: it is worded as needing a newer server and offers no Retry. Other components keep the
 * ordinary failure wording rather than being relabelled.
 */
function readUsageScopeRefusal(states: readonly UsageCoverageStatus[]) {
  const codes = new Set<NonNullable<ReturnType<typeof usageScopeRefusalCode>>>();
  let canChangePageScope = false;
  for (const state of states) {
    const code = usageScopeRefusalCode(state);
    if (!code) continue;
    codes.add(code);
    canChangePageScope ||= usagePageReadFamily(state.source) !== 'quota';
  }
  return codes.size ? { codes: [...codes], canChangePageScope } : null;
}

export function UsageScopeRefusalLine(props: Readonly<{
  testID: string;
  codes: readonly NonNullable<ReturnType<typeof usageScopeRefusalCode>>[];
  onChangeScope?: () => void;
}>) {
  return (
    <>
      <SurfaceFreshnessLine
        testID={props.testID}
        presentation="inline"
        tone="neutral"
        reason={t('usage.board.page.scopeReadRefused')}
        {...(props.onChangeScope ? { action: {
          label: t('usage.board.page.changeScope'),
          onPress: props.onChangeScope,
          testID: `${props.testID}.changeScope`,
        } } : {})}
      />
      <TechnicalDetailsDisclosure
        title={t('approvals.technicalDetails')}
        testID={`${props.testID}.technicalDetails`}
        lines={props.codes.map(code => ({ key: code, label: t('approvals.failureTechnicalLabels.causeCode'), value: code }))}
      />
    </>
  );
}

/** Coverage of the displayed accounting values. The replacement read has its own disclosure. */
export function usageAdmittedAccountingCoverage(accounting: UsageQueryResultSlice['accounting']): Readonly<{ short: string; long: string }> | undefined {
  const status = readAdmittedAccountingGap(accounting);
  if (!status) return undefined;
  return {
    short: t('usage.board.charts.coveragePartialShort'),
    long: [
      formatUsageCoverageHeadline([{ source: 'accounting', status }], usageSourceTitle('accounting')),
      ...usageAccountingCoverageReasons(accounting?.coverage),
    ].join(' · '),
  };
}

/** One wording owner for the page's Sources chooser and the failed or pending line. */
export function usageCoverageDescription(slice: UsageQueryResultSlice, sources: readonly string[]): string {
  const gaps = readUsageCoverageGaps(slice, sources);
  if (!gaps.length) return '';
  const nameGaps = (list: readonly UsageQuerySourceState[]) => [...new Set(list.map(gap => gap.status === 'unsupported'
    ? `${usageSourceTitle(gap.source)} (${t('usage.board.sources.unsupported')})` : usageSourceTitle(gap.source)))].join(', ');
  const newer = gaps.filter(needsNewerServer);
  const rest = gaps.filter(gap => !needsNewerServer(gap) && !isUsageWorkOffline(gap) && !isUsageQuotaOwnershipUnproven(gap) && !usageScopeRefusalCode(gap));
  const reasons = sources.includes('accounting')
    ? usageAccountingCoverageReasons(slice.accounting?.coverage) : [];
  return [
    ...(rest.length ? [formatUsageCoverageHeadline(rest, nameGaps(rest))] : []),
    ...(gaps.some(isUsageQuotaOwnershipUnproven) ? [t('connectedServices.errors.quotaOwnershipUnproven', {})] : []),
    ...(gaps.some(isUsageWorkOffline) ? [t('usage.board.page.workMachinesOffline')] : []),
    ...(newer.length ? [t('usage.board.page.coverageNeedsNewerServer', { sources: nameGaps(newer) })] : []),
    ...reasons,
  ].join(' · ');
}

export type UsageCoverageLineMode = 'hidden' | 'failed' | 'detail';

/**
 * Coverage is said once per surface. On the Usage page the Sources chooser carries the one quiet dot
 * and its detail, and the page header says once what is still being read, so a body keeps a line only
 * for a failed read (with Retry). Hosts without those page indicators keep the full detail line.
 */
export function usageCoverageLineMode(gaps: readonly UsageCoverageStatus[], pageHasDetail: boolean): UsageCoverageLineMode {
  if (gaps.length === 0) return 'hidden';
  // A failed page read is said once by the page header; only a
  // widget's own failed read (a comparison, a pool selection) keeps its line beside the body.
  const ownFailure = gaps.some(gap => isUsageCoverageFailure(gap) && !isUsagePageReadSource(gap));
  if (gaps.some(isUsageCoverageFailure)) return pageHasDetail ? ownFailure ? 'failed' : 'hidden' : 'detail';
  return pageHasDetail ? 'hidden' : 'detail';
}

/** The page header's one "Still reading …" fact: every source any view's read still waits on, named once. */
const USAGE_PAGE_READ_SOURCES: ReadonlySet<string> = new Set(['accounting', 'quota', 'work', 'how_you_work']);

function isUsagePageReadSource(source: UsageCoverageStatus): boolean {
  return USAGE_PAGE_READ_SOURCES.has(usagePageReadFamily(source.source))
    || (source.source === 'how_you_work:transcripts' && usageScopeRefusalCode(source) !== null);
}

function readUsagePageFailures(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): UsageQuerySourceState[] {
  return slices.flatMap(slice => slice.sources.filter(source => isUsageCoverageFailure(source) && isUsagePageReadSource(source)
    && !isUsageWorkSettledWithEvidence(source)));
}

/** Whether this Home's server is too old to answer one page read (`how_you_work`, `work`): a figure that read fills says so, not "not measured yet". */
export function readUsageSourceNeedsNewerServer(slice: Pick<UsageQueryResultSlice, 'sources'>, source: string): boolean {
  return slice.sources.some(gap => usagePageReadFamily(gap.source) === source && needsNewerServer(gap));
}

/** The page header's one "Reading … needs a newer server" fact: shared reads this Home's server is too old for. */
export function describeUsagePageNewerServerSources(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): string | null {
  const names = [...new Set(slices.flatMap(slice => slice.sources
    .filter(source => isUsagePageReadSource(source) && needsNewerServer(source))
    .map(source => usageSourceTitle(usagePageReadFamily(source.source)))))];
  return names.length ? t('usage.board.page.coverageNeedsNewerServer', { sources: names.join(', ') }) : null;
}

/**
 * One notice for failed reads owned by the page. The same typed failures decide its
 * wording, recovery, and the time of any retained quota reading.
 */
export function readUsagePageFailure(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'howYouWork'>[]) {
  const failures = readUsagePageFailures(slices);
  const scopeRefusal = readUsageScopeRefusal(failures);
  const retryable = failures.filter(canRetryUsageCoverageFailure);
  const ownershipUnproven = failures.some(isUsageQuotaOwnershipUnproven);
  // A settled Work answer with Sessions that failed retryably is partly read: said as what arrived, never as an outage
  // (r226 #61), and the page's one Retry rereads it (ruling 11-25 00:15Z: the header is the one recovery surface).
  const workPartlyRead = readUsagePageWorkRetryable(slices);
  if (!scopeRefusal && !retryable.length && !ownershipUnproven && !workPartlyRead) return null;
  const quiet = !ownershipUnproven && retryable.every(source => source.source === 'work');
  const names = [...new Set(retryable.map(source => usageSourceTitle(usagePageReadFamily(source.source))))].join(', ');
  const witnessed = readUsagePageWitnessedNames(slices);
  // "Not available" only while nothing of Work is shown; a failed reread over retained links says what arrived.
  const nothingShown = retryable.every(source => source.status === 'error');
  const reason = [
    ...(names ? [quiet && nothingShown && !witnessed.length ? t('usage.board.page.workNotRead') : witnessed.length
      ? t('usage.board.page.coverageFailedWitnessed', { sources: names, witnessed: witnessed.join(', ') })
      : t('usage.board.page.coverageFailed', { sources: names })]
      : workPartlyRead ? [t('usage.board.page.coverageWitnessed', { sources: witnessed.join(', ') })] : []),
    ...(ownershipUnproven ? [t('connectedServices.errors.quotaOwnershipUnproven', {})] : []),
  ].join(' · ');
  const quotaTimes = retryable.flatMap(source => usagePageReadFamily(source.source) === 'quota' && source.asOfMs !== undefined ? [source.asOfMs] : []);
  // An ownership refusal is retried by an explicit reread (the owner's same-material recovery), so the notice offers the
  // page's one Retry for it too (acceptance 11-22 #20).
  return { scopeRefusal, reason, quiet, retryable: retryable.length > 0 || ownershipUnproven || workPartlyRead, retainedQuotaAsOfMs: quotaTimes.length ? Math.min(...quotaTimes) : null };
}

/**
 * The page header's one partial fact: a page read that settled with only some Sessions' evidence (the rest
 * refused or unreadable) shows what it witnessed, said here once. Partial usage history is a different
 * cause, carried by the Sources chooser's coverage detail.
 */
function readUsagePageWitnessedNames(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'howYouWork'>[]): string[] {
  return [...new Set(slices.flatMap(slice => slice.sources
    .filter(source => {
      if (isUsageWorkSettledWithEvidence(source)) return source.unreadSessions !== undefined;
      // A quiet activity reread keeps its witnessed subset visible.
      return source.source === 'how_you_work' && (source.status === 'partial'
        || source.status === 'pending' && source.asOfMs !== undefined && slice.howYouWork?.detailStatus === 'partial');
    })
    .map(source => usageSourceTitle(source.source))))];
}

/** Said alone only when no page read failed; otherwise the failed fact carries it. */
export function describeUsagePagePartialSources(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'howYouWork'>[]): string | null {
  const names = readUsagePageWitnessedNames(slices);
  if (!names.length || readUsagePageFailures(slices).some(canRetryUsageCoverageFailure) || readUsagePageWorkRetryable(slices)) return null;
  return t('usage.board.page.coverageWitnessed', { sources: names.join(', ') });
}

export function readUsagePageFreshness(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'quota' | 'accounting'>[]) {
  let hasAccounting = false;
  let accountingAsOf: number | null = null;
  let retainedAccountingReadAtMs: number | null = null;
  let olderSource: { source: string; asOfMs: number } | null = null;
  let quotaAsOf: number | null = null;
  let workAsOf: number | null = null;
  for (const slice of slices) {
    hasAccounting ||= slice.accounting !== undefined;
    for (const source of slice.sources) {
      if (source.source === 'accounting' && source.status !== 'not_loaded') {
        hasAccounting = true;
        const readAtMs = readUsageAccountingReadAtMs(slice);
        if (readAtMs !== undefined) {
          accountingAsOf = accountingAsOf === null ? readAtMs : Math.max(accountingAsOf, readAtMs);
          if (slice.accounting && (source.status === 'error' || source.status === 'stale')) {
            retainedAccountingReadAtMs = retainedAccountingReadAtMs === null ? readAtMs : Math.min(retainedAccountingReadAtMs, readAtMs);
          }
          if (slice.accounting && source.asOfMs !== undefined && (olderSource === null || source.asOfMs < olderSource.asOfMs)
            && isUsageObservationFromEarlierDay(source.asOfMs, readAtMs)) {
            olderSource = readUsageOldestAccountingObservation(slice.accounting) ?? olderSource;
          }
        }
      } else if (source.source === 'work' && source.asOfMs !== undefined && USAGE_WORK_READABLE_STATUSES.has(source.status)) {
        workAsOf = workAsOf === null ? source.asOfMs : Math.min(workAsOf, source.asOfMs);
      } else if ((source.source === 'quota' || source.source.startsWith('quota:')) && source.asOfMs !== undefined) {
        quotaAsOf = quotaAsOf === null ? source.asOfMs : Math.max(quotaAsOf, source.asOfMs);
      }
    }
    // A refresh can retain individual account facts before its qualified source
    // rows arrive. The aggregate quota date deliberately remains conservative.
    for (const read of slice.quota ?? []) {
      if (read.current && wasConnectedServiceQuotaObserved(read.current)) {
        quotaAsOf = quotaAsOf === null ? read.current.fetchedAtMs : Math.max(quotaAsOf, read.current.fetchedAtMs);
      }
    }
  }
  // A usage event does not reread Work: links read in an earlier minute than the accounting shown are named apart in
  // Details, so the page's one date never claims them (J-A35). The ledger total says their own time.
  if (hasAccounting && accountingAsOf !== null && workAsOf !== null && Math.floor(workAsOf / 60_000) < Math.floor(accountingAsOf / 60_000)
    && (olderSource === null || workAsOf < olderSource.asOfMs)) olderSource = { source: 'work', asOfMs: workAsOf };
  // Only a successful accounting read dates an accounting page. Older reads
  // and source observations remain separate facts for its Details.
  return { asOfMs: hasAccounting ? accountingAsOf : quotaAsOf, retainedAccountingReadAtMs, olderSource };
}

export function describeUsagePagePendingSources(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'accounting'>[]): string | null {
  // Only the page's shared reads; a widget's own read (a pool selection) is said by that widget.
  const names = [...new Set(slices.flatMap(slice => slice.sources
    // Not loaded also describes intentionally undemanded private evidence.
    // Only its producer's pending state establishes that a read is in flight.
    .filter(source => source.status === 'pending' && !isWidgetResourceQuietRefresh(source.asOfMs !== undefined
      || source.source === 'accounting' && slice.accounting !== undefined))
    // A sibling can already supply the aggregate quota while this account is still being read.
    // Keep qualified identity at the Resource; the shared header names its read family only once.
    .map(source => source.source.startsWith('quota:') ? 'quota' : source.source)
    .filter(source => USAGE_PAGE_READ_SOURCES.has(source))
    .map(source => usageSourceTitle(source))))];
  return names.length ? t('usage.board.page.coveragePending', { sources: names.join(', ') }) : null;
}

export function UsageCoverageLine(
  props: Readonly<{
    slice: UsageQueryResultSlice;
    sources: readonly string[];
    onRetry?: UsageRetryRead;
    testID: string;
  }>,
) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const allGaps = readUsageCoverageGaps(props.slice, props.sources);
  const mode = usageCoverageLineMode(allGaps, pageHasDetail);
  const visibleGaps = mode === 'failed'
    ? allGaps.filter(gap => isUsageCoverageFailure(gap) && !isUsagePageReadSource(gap)) : allGaps;
  const refusal = readUsageScopeRefusal(visibleGaps);
  const gaps = visibleGaps.filter(gap => !usageScopeRefusalCode(gap));
  const failed = gaps.some(gap => isUsageCoverageFailure(gap) && !needsNewerServer(gap));
  const canRetry = gaps.some(canRetryUsageCoverageFailure) && !!props.onRetry;
  const retry = useUsageRetryCommand((callerContext, options) => props.onRetry?.(callerContext, options), mode !== 'hidden' && canRetry);
  if (mode === 'hidden') return null;
  // On a page only local failures are here. Shared sources have their recovery in the page notice.
  const reason = mode === 'failed'
    ? t('usage.board.page.coverageFailed', { sources: [...new Set(gaps.map(gap => usageSourceTitle(gap.source)))].join(', ') })
    : usageCoverageSummary(props.slice, props.sources);
  const pending = gaps.every(
    (gap) => gap.status === 'pending' || gap.status === 'not_loaded',
  );
  const asOf = gaps.reduce<number | null>(
    (oldest, gap) =>
      gap.asOfMs === undefined
        ? oldest
        : oldest === null
          ? gap.asOfMs
          : Math.min(oldest, gap.asOfMs),
    null,
  );
  return (
    <>
      {refusal && <UsageScopeRefusalLine testID={gaps.length ? `${props.testID}.scopeRefused` : props.testID} codes={refusal.codes} />}
      {gaps.length > 0 && <SurfaceFreshnessLine
        testID={props.testID}
        busy={pending}
        tone={failed ? 'warning' : 'neutral'}
        reason={[...(asOf === null ? [] : [t('usage.board.page.oldestSourceUpdate', { time: formatUsageObservedAt(asOf) })]), reason].join(' · ')}
        {...(canRetry ? { action: { label: t('common.retry'), onPress: retry } } : {})}
      />}
    </>
  );
}

/** A card's one quiet closing note (a qualifier said once for every figure above it, never under each). */
export function UsageBodyNote(props: Readonly<{ children: string; testID?: string }>) {
    return <Text style={noteStyles.note} testID={props.testID}>{props.children}</Text>;
}

const noteStyles = StyleSheet.create((theme) => ({
    note: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
}));

/** The Agent's catalog mark, standing on its own (no tile), in ink. */
export function UsageAgentMark(props: Readonly<{ agentId: string; serverId: string | null; size?: number; color?: string }>) {
    const entry = React.useMemo(() => { try { return resolveAgentCatalogProjection(props.agentId, { enabledAgentIds: [] }); } catch { return null; } }, [props.agentId]);
    if (!entry) return null;
    return <AgentCatalogIdentityIcon entry={entry} machineId={null} serverId={props.serverId} current={false}
        size={props.size ?? ICON_SIZE.sm} {...(props.color ? { color: props.color } : {})} />;
}

/** A list leads with its largest rows; a long tail stays one press away (the shared plugin-ui owner). */
export const leadingUsageRows = leadHappierListRows;

/** One quiet line under a led list. */
const SETTLED_QUIET_LINE_PX = 18;

/**
 * The one footer under a led list (Projections, Breakdowns, Session value, How you work): the shared plugin-ui
 * overflow footer with Usage's words, plus the page's local command. `unlisted` is what the list cannot show
 * ("+10 windows not reported"), said once beside the toggle. Draws nothing when there is nothing to fold or report.
 * Its toggle is always "Show all · N": a partial list says what is missing through `unlisted`, never through a
 * second word for the same control ("Show available" beside a chart's "Show all", acceptance 11-21 #17).
 */
export function UsageShowAllRows(props: Readonly<{
  label: string; total: number; hidden: number; expanded: boolean; onToggle: () => void;
  unlisted?: string | null; testID: string;
}>) {
  const theme = useUsagePluginTheme();
  const toggle = useUsageDisclosureCommand(props.label, props.expanded, props.onToggle, props.hidden > 0 || props.expanded);
  return (
    <HappierListOverflowFooter theme={theme} label={props.label} total={props.total} hidden={props.hidden}
      expanded={props.expanded} onToggle={toggle} unlisted={props.unlisted ?? null}
      labels={{ showAll: t('usage.showAll'), showLess: t('usage.showLess') }}
      testID={props.testID} />
  );
}
