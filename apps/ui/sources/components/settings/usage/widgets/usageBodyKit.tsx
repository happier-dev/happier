import * as React from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UsageAccountingMetricSchema, type UsageAccountingMetric, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import type {
  UsageQueryResultSlice,
  UsageQuerySourceState,
} from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { USAGE_METER_METRICS } from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { HAPPIER_FRESHNESS_LINE_METRICS, HappierListOverflowFooter, HappierSkeletonBlock, leadHappierListRows } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
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
import { formatUsageCalendarPeriod, formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageSourceTitle } from '@/sync/domains/usage/usageLabels';
export { usageSourceTitle, usageAgentTitle, usageDimensionLabel } from '@/sync/domains/usage/usageLabels';
import { useUsageWidgetPageHasCoverageDetail } from './usageWidgetBatch';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { useUsageDisclosureCommand } from './usageMountedControls';
import { isWidgetResourceQuietRefresh } from '@/components/widgets/frame/widgetFrameResourceActivity';

/** What every Usage body receives from the one dispatcher: admitted facts, never a fetch handle. */
export type UsageBodyProps = Readonly<{
  id: UsageBuiltinWidgetIdV1;
  model: UsageWidgetBodyModel;
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

/** Exact shown dates; a date range does not establish a rolling preset identity. */
export function usagePeriodPhrase(query: Pick<UsageQuery, 'period' | 'timeZoneOffsetMinutes'>): string {
  return formatUsageCalendarPeriod({ ...query.period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes });
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

/** Names stay in the opened Account projection; accounting carries only the Project anchor. */
export function useUsageProjectLabels(serverId: string): ReadonlyMap<string, string> {
  const rows = useProjectAccountRows();
  return React.useMemo(() => {
    const labels = new Map<string, string>();
    if (!rows || rows.status === 'locked' || rows.status === 'refused'
      || !areServerProfileIdentifiersEquivalent(rows.scope.serverId, serverId)) return labels;
    const projection = projectProjectListV1({ serverId, workspaceRefs: rows.workspaceRefs,
      organizations: rows.organizations, normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    const groups = [...projection.projectGroups, ...projection.hiddenProjectGroups];
    const refs = groups.flatMap(group => {
      const ref = group.items[0];
      const label = rows.organizations.find(row => row.key.projectKey === group.projectKey.projectKey)?.value.label;
      return ref ? [{ ...ref, ...(label ? { label } : {}) }] : [];
    });
    for (const group of groups) {
      const ref = refs.find(ref => ref.id === group.items[0]?.id && ref.serverId === group.items[0]?.serverId);
      if (ref) labels.set(group.projectKey.projectKey, resolveWorkspaceRefDisplayName(ref, refs));
    }
    // The opened snapshot supplies Home/Account authority. Native opaque keys
    // retain their producing CLI profile namespace, which is not a UI Home id
    // or routing grant; join those keys only within this admitted snapshot.
    for (const row of rows.organizations) {
      if (row.value.label && !labels.has(row.key.projectKey)) labels.set(row.key.projectKey, row.value.label);
    }
    return labels;
  }, [rows, serverId]);
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
            <View key={index} style={index === 0 ? readingStyles.summaryStatLead : readingStyles.summaryStat}>
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
  summaryStat: { flexGrow: 1, flexBasis: 100, minWidth: 0, gap: 2 },
  summaryStatLead: { flexGrow: 2, flexBasis: 168, minWidth: 0, gap: 2 },
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
  onRetry: () => void;
  /** The shape the body will take, so its first read holds that room. */
  readingShape?: React.ComponentProps<typeof UsageBodyReading>['shape'];
}>) {
  if (isUsageReadOutstanding(props.slice, ['accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: USAGE_ACCOUNTING_SOURCES }} {...(props.readingShape ? { shape: props.readingShape } : {})} />;
  if (!props.slice.accounting)
    return <UsageBodyReadFailed slice={props.slice} sources={USAGE_ACCOUNTING_SOURCES} testID={props.testID} onRetry={props.onRetry} />;
  return (
    <UsageBodyInsufficient
      testID={`${props.testID}.empty`}
      title={t('usage.board.page.noUsageTitle')}
      reason={t('usage.board.page.noUsageReason')}
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
  slice: UsageQueryResultSlice;
  sources: readonly string[];
  testID: string;
  onRetry: () => void;
}>) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const gaps = readUsageCoverageGaps(props.slice, props.sources);
  const failed = gaps.some(gap => gap.status === 'error');
  if (pageHasDetail && failed && usageCoverageLineMode(gaps, true) === 'hidden')
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
    <SurfaceStateCard
      testID={`${props.testID}.unavailable`}
      kind={failed ? 'error' : 'unavailable'}
      layout="inline"
      size="line"
      replacesContent={false}
      title={t('usage.board.page.readFailedTitle')}
      reason={t('usage.board.page.readFailedReason')}
      action={{ label: t('common.retry'), onPress: props.onRetry }}
    />
  );
}

export function UsageBodyInsufficient(
  props: Readonly<{
    title: string;
    reason?: string;
    testID: string;
    /** False for an insufficient sub-section beside admitted facts. */
    replacesContent?: boolean;
    action?: Readonly<{ label: string; onPress: () => void }>;
  }>,
) {
  // A state that replaces the body is the widget's empty state: the frame sizes it (centred in a card with
  // room, one line in a compact footprint or a column). A sub-section beside admitted facts stays one line.
  const replacesContent = props.replacesContent !== false;
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
              onPress: props.action.onPress,
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

/** Sources this body depends on that are not complete, worded once under the content. */
export function readUsageCoverageGaps(
  slice: UsageQueryResultSlice,
  sources: readonly string[],
): readonly UsageQuerySourceState[] {
  const accounting = sources.includes('accounting') ? slice.accounting?.coverage : undefined;
  const dependent = new Set([...sources, ...(accounting?.sources.map(source => source.source) ?? [])]);
  const quotaRequested = sources.includes('quota');
  const gaps = slice.sources.filter(source => (dependent.has(source.source)
    || quotaRequested && source.source.startsWith('quota:')) && source.status !== 'available');
  // Comparison owns its source state beside its exact preceding query, rather
  // than in the slice's general source list. Consumers must see that same state.
  if (dependent.has('comparison') && slice.comparison && slice.comparison.source.status !== 'available')
    gaps.push(slice.comparison.source);
  // Transport settlement does not establish history completeness. Keep the
  // settled allowance's qualification visible between refreshes as well.
  if (quotaRequested && slice.quota?.some(read => read.history?.nextCursor != null
    || read.unusedCapacity && read.unusedCapacity.historyStatus !== 'returned_page')
    && !gaps.some(source => source.source === 'quota')) {
    const clocks = slice.quota.flatMap(read => read.current && wasConnectedServiceQuotaObserved(read.current)
      ? [read.current.fetchedAtMs] : []);
    gaps.push({ source: 'quota', status: 'partial', ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) });
  }
  if (sources.includes('accounting') && slice.accounting && !accounting
    && !gaps.some(source => source.source === 'accounting')) {
    gaps.unshift({ source: 'accounting', status: 'unknown' });
  }
  if (accounting && (accounting.status !== 'complete' || accounting.range.complete !== true || accounting.reasons.length > 0)
    && !gaps.some(source => source.source === 'accounting')) {
    const asOfMs = slice.sources.find(source => source.source === 'accounting')?.asOfMs;
    gaps.unshift({ source: 'accounting', status: accounting.status === 'complete' ? 'partial' : accounting.status,
      ...(asOfMs === undefined ? {} : { asOfMs }) });
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

function usageCoverageHeadlineKey(gaps: readonly Pick<UsageQuerySourceState, 'status'>[]) {
  return gaps.some(gap => gap.status === 'error') ? 'usage.board.page.coverageFailed' as const
    : gaps.every(gap => gap.status === 'pending' || gap.status === 'not_loaded') ? 'usage.board.page.coveragePending' as const
      : 'usage.board.page.coveragePartial' as const;
}

/**
 * The one quiet clause a body's own line carries when its host has no Sources detail (Home, a Board): a read
 * still going or failed names its sources (a failure with its Retry); an incomplete read says only "Partial
 * history", never a paragraph of sources and reasons. The full wording is `usageCoverageDescription`.
 */
export function usageCoverageSummary(slice: UsageQueryResultSlice, sources: readonly string[]): string {
  const gaps = readUsageCoverageGaps(slice, sources);
  if (!gaps.length) return '';
  if (!gaps.some(needsNewerServer) && usageCoverageHeadlineKey(gaps) === 'usage.board.page.coveragePartial') return usagePartialHistoryLabel();
  return usageCoverageDescription(slice, sources);
}

/** "Partial history": the whole of what a body's quiet line says about an incomplete read. */
export function usagePartialHistoryLabel(): string {
  const text = t('usage.board.page.factIncomplete');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A failed read this Home's server is too old to answer (a typed `update_required` for the server). It is not a
 * failure to retry: it is worded as needing a newer server and offers no Retry. Other components keep the
 * ordinary failure wording rather than being relabelled.
 */
function needsNewerServer(gap: Pick<UsageQuerySourceState, 'status' | 'updateRequired'>): boolean {
  return gap.status === 'error' && gap.updateRequired?.component === 'server';
}

/** One wording owner for the page's Sources chooser and the failed or pending line. */
export function usageCoverageDescription(slice: UsageQueryResultSlice, sources: readonly string[]): string {
  const gaps = readUsageCoverageGaps(slice, sources);
  if (!gaps.length) return '';
  const nameGaps = (list: readonly UsageQuerySourceState[]) => [...new Set(list.map(gap => gap.status === 'unsupported'
    ? `${usageSourceTitle(gap.source)} (${t('usage.board.sources.unsupported')})` : usageSourceTitle(gap.source)))].join(', ');
  const newer = gaps.filter(needsNewerServer);
  const rest = gaps.filter(gap => !needsNewerServer(gap));
  const reasons = sources.includes('accounting')
    ? [...new Set(slice.accounting?.coverage?.reasons ?? [])].map(reason => t(COVERAGE_REASON_KEYS[reason])) : [];
  return [
    ...(rest.length ? [t(usageCoverageHeadlineKey(rest), { sources: nameGaps(rest) })] : []),
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
export function usageCoverageLineMode(gaps: readonly (Pick<UsageQuerySourceState, 'status'> & { source?: string })[], pageHasDetail: boolean): UsageCoverageLineMode {
  if (gaps.length === 0) return 'hidden';
  // A failed page read is said once by the page header (`describeUsagePageFailedSources`); only a
  // widget's own failed read (a comparison, a pool selection) keeps its line beside the body.
  const ownFailure = gaps.some(gap => gap.status === 'error' && !(gap.source !== undefined && isUsagePageReadSource(gap.source)));
  if (gaps.some(gap => gap.status === 'error')) return pageHasDetail ? ownFailure ? 'failed' : 'hidden' : 'detail';
  return pageHasDetail ? 'hidden' : 'detail';
}

/** The page header's one "Still reading …" fact: every source any view's read still waits on, named once. */
const USAGE_PAGE_READ_SOURCES: ReadonlySet<string> = new Set(['accounting', 'quota', 'work', 'how_you_work']);

function usagePageReadFamily(source: string): string {
  return source.startsWith('quota:') ? 'quota' : source;
}

function isUsagePageReadSource(source: string): boolean {
  return USAGE_PAGE_READ_SOURCES.has(usagePageReadFamily(source));
}

function readUsagePageFailedNames(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[], newerServer = false): string[] {
  return [...new Set(slices.flatMap(slice => slice.sources
    .filter(source => source.status === 'error' && isUsagePageReadSource(source.source) && needsNewerServer(source) === newerServer)
    .map(source => usageSourceTitle(usagePageReadFamily(source.source)))))];
}

/** Whether this Home's server is too old to answer one page read (`how_you_work`, `work`): a figure that read fills says so, not "not measured yet". */
export function readUsageSourceNeedsNewerServer(slice: Pick<UsageQueryResultSlice, 'sources'>, source: string): boolean {
  return slice.sources.some(gap => usagePageReadFamily(gap.source) === source && needsNewerServer(gap));
}

/** The page header's one "Reading … needs a newer server" fact: shared reads this Home's server is too old for. */
export function describeUsagePageNewerServerSources(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): string | null {
  const names = readUsagePageFailedNames(slices, true);
  return names.length ? t('usage.board.page.coverageNeedsNewerServer', { sources: names.join(', ') }) : null;
}

/**
 * The page header's one "Couldn't read …" fact: every shared read that failed, named once for the page. A read
 * that settled with only some Sessions' evidence joins the same sentence, so "Showing what arrived" is said once.
 */
export function describeUsagePageFailedSources(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'howYouWork'>[]): string | null {
  const names = readUsagePageFailedNames(slices);
  if (!names.length) return null;
  const witnessed = readUsagePageWitnessedNames(slices);
  return witnessed.length
    ? t('usage.board.page.coverageFailedWitnessed', { sources: names.join(', '), witnessed: witnessed.join(', ') })
    : t('usage.board.page.coverageFailed', { sources: names.join(', ') });
}

/**
 * The page header's one partial fact: a page read that settled with only some Sessions' evidence (the rest
 * refused or unreadable) shows what it witnessed, said here once. Partial usage history is a different
 * cause, carried by the Sources chooser's coverage detail.
 */
const USAGE_PAGE_WITNESSED_SOURCES: ReadonlySet<string> = new Set(['how_you_work']);

function readUsagePageWitnessedNames(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'howYouWork'>[]): string[] {
  return [...new Set(slices.flatMap(slice => slice.sources
    // A quiet reread of a settled read keeps showing its witnessed subset, so its partial fact stays too.
    .filter(source => USAGE_PAGE_WITNESSED_SOURCES.has(source.source) && (source.status === 'partial'
      || source.status === 'pending' && source.asOfMs !== undefined && slice.howYouWork?.detailStatus === 'partial'))
    .map(source => usageSourceTitle(source.source))))];
}

/** Said alone only when no page read failed; otherwise the failed fact carries it. */
export function describeUsagePagePartialSources(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'howYouWork'>[]): string | null {
  const names = readUsagePageWitnessedNames(slices);
  if (!names.length || readUsagePageFailedNames(slices).length) return null;
  return t('usage.board.page.coverageWitnessed', { sources: names.join(', ') });
}

export function readUsagePageAsOfMs(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'quota'>[]): number | null {
  // Older observations retain their own dates in source detail. The page names
  // its latest witnessed update, never the oldest historical source in a total.
  let latest: number | null = null;
  for (const slice of slices) {
    for (const source of slice.sources) {
      if (source.asOfMs !== undefined) latest = latest === null ? source.asOfMs : Math.max(latest, source.asOfMs);
    }
    // A refresh can retain individual account facts before its qualified source
    // rows arrive. The aggregate quota date deliberately remains conservative.
    for (const read of slice.quota ?? []) {
      if (read.current && wasConnectedServiceQuotaObserved(read.current)) {
        latest = latest === null ? read.current.fetchedAtMs : Math.max(latest, read.current.fetchedAtMs);
      }
    }
  }
  return latest;
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
    onRetry?: () => void | Promise<unknown>;
    testID: string;
  }>,
) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const gaps = readUsageCoverageGaps(props.slice, props.sources);
  const mode = usageCoverageLineMode(gaps, pageHasDetail);
  if (mode === 'hidden') return null;
  const failed = mode === 'failed' || gaps.some((gap) => gap.status === 'error' && !needsNewerServer(gap));
  if (mode === 'failed') {
    // One short line: what failed, with its Retry; the detail is in Sources.
    const names = [...new Set(gaps.filter(gap => gap.status === 'error').map(gap => usageSourceTitle(gap.source)))].join(', ');
    return (
      <SurfaceFreshnessLine
        testID={props.testID}
        tone="warning"
        reason={t('usage.board.page.coverageFailed', { sources: names })}
        {...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})}
      />
    );
  }
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
    <SurfaceFreshnessLine
      testID={props.testID}
      busy={pending}
      tone={failed ? 'warning' : 'neutral'}
      reason={[...(asOf === null ? [] : [t('usage.board.page.oldestSourceUpdate', { time: formatUsageObservedAt(asOf) })]), usageCoverageSummary(props.slice, props.sources)].join(' · ')}
      {...(failed && props.onRetry
        ? { action: { label: t('common.retry'), onPress: props.onRetry } }
        : {})}
    />
  );
}

/** The Agent's catalog mark, standing on its own (no tile), in ink. */
export function UsageAgentMark(props: Readonly<{ agentId: string; serverId: string | null; size?: number; color?: string }>) {
    const entry = React.useMemo(() => { try { return resolveAgentCatalogProjection(props.agentId, { enabledAgentIds: [] }); } catch { return null; } }, [props.agentId]);
    if (!entry) return null;
    return <AgentCatalogIdentityIcon entry={entry} machineId={null} serverId={props.serverId} current={false}
        size={props.size ?? ICON_SIZE.sm} {...(props.color ? { color: props.color } : {})} />;
}

/** A list leads with its largest rows; a long tail stays one press away (the shared plugin-ui owner). */
export const leadingUsageRows = leadHappierListRows;

/** An allowance account reports a session and a longer window; this only sizes the room held while reads arrive. */
const EXPECTED_WINDOWS_PER_ACCOUNT = 2;
/** What the settled list measures: a captioned meter row, the Show all button, one quiet line, the body's row gap. */
const SETTLED_ROW_PX = 43;
const SETTLED_SHOW_ALL_PX = 26;
const SETTLED_QUIET_LINE_PX = 18;
const SETTLED_BODY_GAP_PX = 16;
/** The quiet lines that can close a led list: the unreported-windows note (one line) and the pace legend (two on a phone). */
const SETTLED_LEGEND_LINES = { wide: 1, narrow: 2 } as const;
/** The pace alert ("runs out Thu 02:26 AM before it resets") sits among them and wraps to two lines at a half-width. */
const SETTLED_PACE_NOTE_LINES = 2;

/**
 * The room a list of allowance windows holds while their reads still arrive, from the accounts already
 * known: rows fill it and the notes under them join it, so nothing below the list moves until the
 * reads settle. Undefined when no allowance read is outstanding or no account is known yet.
 */
export function readUsageMeterListReserve(slice: UsageQueryResultSlice, accountCount: number, narrow = false): Readonly<{
  shape: Extract<NonNullable<React.ComponentProps<typeof UsageBodyReading>['shape']>, { kind: 'meters' }>;
  minHeight: number;
}> | undefined {
  const outstanding = readUsageCoverageGaps(slice, ['quota']).some(gap => gap.status === 'pending' || gap.status === 'not_loaded');
  if (!outstanding || accountCount < 1) return undefined;
  const led = leadingUsageRows(Array.from({ length: accountCount * EXPECTED_WINDOWS_PER_ACCOUNT }), false);
  const rows = led.rows.length;
  const gap = SETTLED_BODY_GAP_PX;
  const minHeight = rows * SETTLED_ROW_PX + (rows - 1) * USAGE_METER_METRICS.rowGapPx
    + (led.hidden > 0 ? gap + SETTLED_SHOW_ALL_PX : 0)
    + (gap + SETTLED_QUIET_LINE_PX)
    + gap + SETTLED_LEGEND_LINES[narrow ? 'narrow' : 'wide'] * SETTLED_QUIET_LINE_PX
    + gap + SETTLED_PACE_NOTE_LINES * SETTLED_QUIET_LINE_PX;
  return { shape: { kind: 'meters', rows }, minHeight };
}

/**
 * The list's first-read room: held from the first frame until every account has answered once, through the
 * reads' arrivals, so the pace alert, its shared reason and the legend come and go inside it and the body
 * settles its height once. After that settle a re-read never reserves again, so it cannot add blank room
 * under retained rows. Nothing is held before the read's accounts are known.
 */
export function useUsageMeterListFirstReadReserve(
  slice: UsageQueryResultSlice,
  accountCount: number,
  everyAccountAnswered: boolean,
  narrow: boolean,
): ReturnType<typeof readUsageMeterListReserve> {
  const settledOnce = React.useRef(false);
  if (everyAccountAnswered) settledOnce.current = true;
  return settledOnce.current ? undefined : readUsageMeterListReserve(slice, accountCount, narrow);
}

/**
 * The height a settled list body has shown, kept while it stays open. Its optional lines (the pace alert, the
 * shared reason, the legend) come and go with every read, so once the body has settled and a re-read begins it keeps
 * the tallest height it has drawn and they come and go inside it. The cold read's own first settle is not a re-read:
 * the floor follows the drawn height up or down until the first re-read, so late arrivals (stored dismissals,
 * hidden findings) shrink the body once instead of leaving blank room. The floor starts over when the viewer changes
 * the list's own shape (Show all, a resize), so a deliberate collapse is never held open. Before the first settle the
 * first-read reserve holds the room. `onLayout` belongs on a view that does not carry the floor as its own min height.
 */
export function useSettledBodyHeightFloor(settled: boolean, shapeKey: string): Readonly<{
  minHeight: number | undefined;
  onLayout: (event: LayoutChangeEvent) => void;
}> {
  const [floor, setFloor] = React.useState<Readonly<{ shapeKey: string; height: number; keepTallest: boolean }>>({ shapeKey, height: 0, keepTallest: false });
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    if (!settled) return;
    const height = Math.ceil(event.nativeEvent.layout.height);
    setFloor((current) => current.shapeKey !== shapeKey ? { shapeKey, height, keepTallest: false }
      : current.keepTallest && height <= current.height ? current : { ...current, height });
  }, [settled, shapeKey]);
  // A re-read puts accounts back to pending: the floor recorded while settled stays and from then on only grows.
  React.useEffect(() => {
    if (!settled) setFloor((current) => current.height > 0 && !current.keepTallest ? { ...current, keepTallest: true } : current);
  }, [settled]);
  return { minHeight: floor.shapeKey === shapeKey && floor.height > 0 ? floor.height : undefined, onLayout };
}

/**
 * The one footer under a led list (Projections, Breakdowns, Session value, How you work): the shared plugin-ui
 * overflow footer with Usage's words, plus the page's local command. `unlisted` is what the list cannot show
 * ("+10 windows not reported"), said once beside the toggle. Draws nothing when there is nothing to fold or report.
 */
export function UsageShowAllRows(props: Readonly<{
  label: string; total: number; hidden: number; complete?: boolean; expanded: boolean; onToggle: () => void;
  unlisted?: string | null; testID: string;
}>) {
  const theme = useUsagePluginTheme();
  useUsageDisclosureCommand(props.label, props.expanded, props.onToggle, props.hidden > 0 || props.expanded);
  return (
    <HappierListOverflowFooter theme={theme} label={props.label} total={props.total} hidden={props.hidden}
      expanded={props.expanded} onToggle={props.onToggle} complete={props.complete} unlisted={props.unlisted ?? null}
      labels={{ showAll: t('usage.showAll'), showAvailable: t('usage.showAvailable'), showLess: t('usage.showLess') }}
      testID={props.testID} />
  );
}
