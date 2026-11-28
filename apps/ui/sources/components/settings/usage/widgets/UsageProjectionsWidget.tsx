import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  BurnUpChart,
  ChartDatum,
  describeHappierSeriesBucket,
  formatHappierDataExactShare,
  formatHappierDataValue,
  HAPPIER_PAGE_METRICS,
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierDataMetric,
  HappierPressable,
  resolveHappierFreshnessText,
  type HappierSeries,
  type StackedSeriesBand,
} from '@happier-dev/plugin-ui/presentation';
import {
  UsageMeterRow,
  UsageMeterStack,
} from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { visuallyHiddenStyle } from '@/components/ui/accessibility/visuallyHiddenStyle';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useUsageChartDetails } from './usageMountedControls';
import { usageSignatureAccent } from '../usageAccent';
import {
  leadingUsageRows,
  UsageBodyInsufficient,
  UsageBodyReading,
  UsageShowAllRows,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import {
  expireUsagePlanAccount,
  readUsagePlanReadingExpiry,
  projectUsageEarlierCurves,
  projectUsagePastCycles,
  selectUsagePacedWindows,
  type UsagePlanAccount,
  type UsagePlanPastCycle,
  type UsagePlanWindow,
} from './plans/usagePlansModel';
import { useUsagePlans } from './plans/useUsagePlans';
import {
  formatPlanPercent,
  formatPlanResetPhrase,
  planPaceReasonText,
  planWindowStatement,
  UsagePlanDisclosure,
  UsagePlanLegend,
  UsagePlanAccountStates,
  UsagePlansNothingRead,
  isUsagePlanAccountFirstReading,
  isUsagePlanAccountSettledUnread,
  usePlanText,
} from './plans/UsagePlanParts';
import { readUsagePersonalPaceTarget, selectUsageWindowsAboveTarget } from './plans/usagePacingTarget';
import { UsageDailyQuotaHistory } from './plans/UsageDailyQuotaHistory';
import { formatMoment } from '@/utils/datetime/formatMoment';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { isQuotaReadingExpired } from '@/sync/domains/connectedServices/accountUsage/quotaReadingExpiry';

/** Below this width a meter stacks its name over the bar and the projection beneath it. */
const STACKED_BELOW_PX = 460;
const EMPIRICAL_BAND = [{ id: 'empirical', lowerSeriesId: 'rangeLow', upperSeriesId: 'rangeHigh' }] as const satisfies readonly StackedSeriesBand[];

type Focus = Readonly<{ account: UsagePlanAccount; window: UsagePlanWindow }>;
type ChartLabels = Readonly<{ observed: string; projected: string; rangeLow: string; rangeHigh: string }>;

/** The window the burn-up opens on: the tightest headline when it has a pace, else the first paced window. */
function pickDefaultFocus(paced: readonly Focus[], tightest: Focus | null): Focus | null {
  if (tightest?.window.pace) return tightest;
  return paced.find((entry) => entry.account.headline === entry.window) ?? paced[0] ?? null;
}

/**
 * Observed share used in this exact window, then this pace to the reset. With several readings the
 * slowest and fastest pace the owner saw are drawn to the reset too: an observed spread, not a forecast.
 */
function buildBurnUp(
  window: UsagePlanWindow,
  nowMs: number,
  labels: ChartLabels | Pick<ChartLabels, 'observed' | 'projected'>,
  colors: Readonly<{ line: string; range: string }>,
  earlier?: Readonly<{ curves: EarlierCurves; color: string }>,
): HappierSeries[] {
  const pace = window.pace!;
  const point = (x: number, y: number) => ({ id: `t${x}`, x, y, label: formatMoment(x, nowMs) });
  const observedPoints = pace.observedCurve.map((sample) => point(sample.observedAtMs, sample.usedFraction * 100));
  const last = observedPoints.at(-1);
  const series: HappierSeries[] = [
    { id: 'observed', label: labels.observed, color: colors.line, points: observedPoints },
  ];
  const resetAtMs = window.resetAtMs;
  if (!last || resetAtMs === null) return series;
  // A line that would pass the limit flattens at it from the moment it gets there (lab p2burn "runs
  // out"), so the scale stays 0–100% instead of stretching to "578%". Every line shares the same moments
  // (now, the projected run-out, the reset), so the empirical band between them stays continuous.
  const projectedAt = pace.projectedUsedFraction * 100;
  const runOutAtMs = projectedAt > 100 && last.y < 100
    ? Math.round(last.x + (resetAtMs - last.x) * (100 - last.y) / (projectedAt - last.y)) : null;
  const moments = [last.x, ...(runOutAtMs !== null && runOutAtMs > last.x && runOutAtMs < resetAtMs ? [runOutAtMs] : []), resetAtMs];
  const toReset = (id: string, label: string, fraction: number, color: string, lineStyle: 'dashed' | 'dotted'): HappierSeries => ({
    id, label, color, lineStyle,
    points: moments.map((x, index) => index === 0 ? { ...last }
      : point(x, Math.min(100, last.y + (fraction * 100 - last.y) * (x - last.x) / (resetAtMs - last.x)))),
  });
  series.push(toReset('projected', labels.projected, pace.projectedUsedFraction, colors.line, 'dashed'));
  if (pace.empiricalRange && 'rangeLow' in labels) {
    series.push(toReset('rangeLow', labels.rangeLow, pace.empiricalRange.min, colors.range, 'dotted'));
    series.push(toReset('rangeHigh', labels.rangeHigh, pace.empiricalRange.max, colors.range, 'dotted'));
  }
  // Earlier comparable windows, laid on this window's own span by their elapsed share (lab `p2burn` B6).
  for (const curve of earlier?.curves ?? []) {
    const ended = formatMoment(curve.window.resetAtMs, nowMs);
    series.push({
      id: `earlier:${curve.window.resetAtMs}`,
      // One look, one key: the legend shows "Earlier windows" once; each point still names its window.
      label: t('usage.board.plans.earlierCurves'),
      color: earlier!.color,
      points: curve.points.map((sample, index) => {
        const x = Math.round(pace.windowStartAtMs + sample.elapsedFraction * curve.window.windowDurationMs);
        return { id: `earlier:${curve.window.resetAtMs}:${index}`, x, y: sample.usedFraction * 100,
          label: `${formatMoment(x, nowMs)} · ${t('usage.board.plans.earlierCurve', { time: ended })}` };
      }),
    });
  }
  return series;
}

type EarlierCurves = Extract<ReturnType<typeof projectUsageEarlierCurves>, { status: 'available' }>['curves'];

/** Why no earlier window is drawn, in words; null when one is. */
function earlierCurvesText(earlier: ReturnType<typeof projectUsageEarlierCurves>): string {
  if (earlier.status === 'unavailable') {
    return t(earlier.reason === 'not_loaded' ? 'usage.board.plans.pastCyclesNotLoaded' : 'usage.board.plans.paceUnknownWindow');
  }
  if (earlier.curves.length > 0) return t('usage.board.plans.earlierShown', { count: earlier.curves.length });
  const first = earlier.excluded[0];
  if (!first) return t('usage.board.plans.pastCyclesNoneEnded');
  return t('usage.board.plans.earlierNone', {
    reason: first.reason === 'single_reading' ? t('usage.board.plans.earlierSingleReading') : planPaceReasonText(first.reason),
  });
}

export function UsageProjectionsWidget(props: UsageBodyProps) {
  const presentation = useWidgetPresentation();
  const width = presentation?.geometry?.width ?? null;
  const tile = presentation?.size === 'small';
  // Beside other widgets (Medium, Wide, a Full band such as Overview's) Projections is the lab's Limits list
  // (`wgusage-CD`, d2views-OV): one meter per reported window with its projection, no burn-up, no disclosures. As a
  // band its burn-up, quota history and past cycles ran ~880 px of near-empty charts (acceptance 11-13 #1), and its
  // focus headline disagreed with Limits; a view of its own (Large, Tall) keeps the chart.
  const list = presentation?.size === 'medium' || presentation?.size === 'wide' || presentation?.size === 'full';
  const { projection, nameOf, nowMs } = useUsagePlans(props.slice, props.model.refresh);
  useWidgetFrameBodyCaption(t('usage.board.plans.projectionsCaption'));
  // The viewer's pick, kept by window identity; a window that stops having a pace falls back to the default.
  const [pickedKey, setPickedKey] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  return <ProjectionsBody {...props} plans={{ projection, nameOf, nowMs }}
    width={width} tile={tile} list={list} pickedKey={pickedKey} setPickedKey={setPickedKey}
    pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} expanded={expanded} setExpanded={setExpanded} />;
}

function ProjectionsBody(props: UsageBodyProps & Readonly<{
  plans: Pick<ReturnType<typeof useUsagePlans>, 'projection' | 'nameOf' | 'nowMs'>;
  width: number | null;
  tile: boolean;
  list: boolean;
  pickedKey: string | null;
  setPickedKey: (key: string) => void;
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  expanded: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}>) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const text = usePlanText();
  const { width, tile, list, pickedKey, setPickedKey, pickerOpen, setPickerOpen, expanded, setExpanded } = props;
  const { projection, nameOf, nowMs: renderedAtMs } = props.plans;
  const nowMs = Date.now();

  // Derive deadlines from the accounts this body presents. A reading that only
  // contributes to the folded used-up tally still has a visible expiry.
  const agingReaders = React.useMemo(() => projection.accounts.flatMap(account => {
    const at = readUsagePlanReadingExpiry(account.read?.current);
    if (at === null || !account.windows.some(window => window.paceUnavailable !== 'stale'
      && (!list || window.remainingFraction !== null))) return [];
    return [{ account, at, expired: expireUsagePlanAccount(account) }];
  }), [projection.accounts, list]);
  const readNextExpiry = React.useCallback((now: number) => {
    let next: number | null = null;
    for (const { at } of agingReaders) {
      if (!isQuotaReadingExpired(at, now) && (next === null || at < next)) next = at;
    }
    return next;
  }, [agingReaders]);
  const expiryNowMs = useSessionListRuntimeDeadlineNowMs(readNextExpiry, agingReaders.length > 0);
  const accounts = React.useMemo(() => {
    const expired = new Map(agingReaders
      .filter(({ at }) => isQuotaReadingExpired(at, Math.max(renderedAtMs, expiryNowMs)))
      .map(({ account, expired }) => [account, expired]));
    return expired.size > 0 ? projection.accounts.map(account => expired.get(account) ?? account) : projection.accounts;
  }, [agingReaders, projection.accounts, expiryNowMs, renderedAtMs]);
  // The tightest headline can only be the chart's default while it still has a pace.
  const tightest = projection.tightest && accounts.includes(projection.tightest.account) ? projection.tightest : null;
  // Settled once every first read has answered; a re-read keeps the last reading (and its pace) in place, so a refresh
  // never swaps a drawn chart for "no pace yet" and back (R6 #4: 534 → 184 → 590 on a cold Overview).
  const settled = accounts.length > 0 && !accounts.some(isUsagePlanAccountFirstReading);
  const paced = React.useMemo(() => settled ? [...selectUsagePacedWindows(accounts)]
    .sort((left, right) => left.window.key.localeCompare(right.window.key)) : [], [accounts, settled]);
  // No focus until every first read has answered: charting whichever paced account answered first moved the chart
  // from window to window as the others landed.
  const focus = React.useMemo(
    () => settled ? paced.find((entry) => entry.window.key === pickedKey) ?? pickDefaultFocus(paced, tightest) : null,
    [settled, paced, pickedKey, tightest],
  );
  const accent = usageSignatureAccent(theme);
  const rangeColor = theme.colors.text.tertiary;
  const ghostColor = theme.colors.border.default;
  const focusAccount = focus?.account;
  const focusWindow = focus?.window;
  const earlier = React.useMemo(
    () => (focusAccount && focusWindow && !list && !tile ? projectUsageEarlierCurves(focusAccount, focusWindow.meterId) : null),
    [focusAccount, focusWindow, list, tile],
  );
  const series = React.useMemo(
    () =>
      focusWindow && !list
        ? buildBurnUp(
            focusWindow,
            Date.now(),
            {
              observed: t('usage.board.plans.burnObserved'),
              projected: t('usage.board.plans.burnProjected'),
              rangeLow: t('usage.board.plans.burnRangeLow'),
              rangeHigh: t('usage.board.plans.burnRangeHigh'),
            },
            { line: accent, range: rangeColor },
            earlier?.status === 'available' && !tile ? { curves: earlier.curves, color: ghostColor } : undefined,
          )
        : [],
    [focusWindow, renderedAtMs, accent, rangeColor, earlier, tile, ghostColor, list],
  );
  // Ghost points join the plot after the current ones, so the axis names the plot's real first and last moment.
  const axisTicks = React.useMemo(() => {
    if (!series.some((entry) => entry.id.startsWith('earlier:'))) return null;
    const xs = series.flatMap((entry) => entry.points.map((point) => Number(point.x)));
    const now = Date.now();
    return [formatMoment(Math.min(...xs), now), formatMoment(Math.max(...xs), now)];
  }, [series, renderedAtMs]);
  const pickerItems = React.useMemo(
    () =>
      paced.map((entry) => ({
        id: entry.window.key,
        title: `${nameOf(entry.account).title} · ${entry.window.label}`,
        subtitle: planWindowStatement(entry.window, nowMs).text,
      })),
    [paced, nameOf, nowMs],
  );
  const selectWindow = React.useCallback((key: string): boolean => {
    if (!paced.some(entry => entry.window.key === key)) return false;
    setPickerOpen(false);
    setPickedKey(key);
    return true;
  }, [paced, setPickedKey, setPickerOpen]);
  const windowCommands = useCurrentUiContextLocalCommands(!list && paced.length > 1 ? [
    { key: 'menuOpen', title: `${t('usage.board.plans.windowPicker')}: ${t('common.open')}`, invoke: () => setPickerOpen(true) },
    { key: 'menuClose', title: `${t('usage.board.plans.windowPicker')}: ${t('common.close')}`, invoke: () => setPickerOpen(false) },
    ...pickerItems.map(item => ({
      key: item.id, title: `${t(`usage.widgets.${props.id}`)}: ${t('usage.board.plans.windowPicker')}: ${item.title}`,
      invoke: () => selectWindow(item.id),
    })),
  ] : []);
  const chooseWindow = React.useCallback((key: string) => { void windowCommands.invoke(key); }, [windowCommands.invoke]);
  const details = useUsageChartDetails(t(`usage.widgets.${props.id}`), !list && Boolean(focus?.window.pace), true);
  if (accounts.length === 0) {
    return (
      <View style={styles.body}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          slice={props.slice}
          promise={t('usage.board.plans.projectionsNoneConnected')}
          onRetry={props.model.refresh}
        />
      </View>
    );
  }
  const stacked = width !== null && width < STACKED_BELOW_PX;
  // A window's row stacks where the shared meter has no room for its projection beside the bar (a half column).
  const rowsStacked = width !== null && width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
  // The viewer's own advice target, as echoed by the same allowance read (lab `p2budget`).
  const target = readUsagePersonalPaceTarget(props.slice.quota?.[0]?.targets ?? []);
  const above = target === null ? [] : selectUsageWindowsAboveTarget(
    accounts.map((account) => ({ title: nameOf(account).title, windows: account.windows })),
    target,
  );
  const targetNote = target === null ? null
    : above.length > 0
      ? t('usage.board.plans.targetAbove', { percent: Math.round(target * 100), windows: above.join(', ') })
      : t('usage.board.plans.targetWithin', { percent: Math.round(target * 100) });
  const windows = accounts.flatMap(account => account.windows
    .map(window => ({ account, window, name: nameOf(account) })));
  const rows = windows.filter(row => row.window.remainingFraction !== null);
  const unreported = windows.filter(row => row.window.remainingFraction === null);
  const onlyUnread = accounts.every(isUsagePlanAccountSettledUnread);
  const focusName = focus ? nameOf(focus.account) : null;
  const focusTitle = focus && focusName ? `${focusName.title} · ${focus.window.label}` : '';
  const pace = focus?.window.pace ?? null;
  // A window already used up has nothing left to run out of: its return is the reset, said by Limits and Resets.
  const depleting = settled ? rows.filter(row => row.window.pace?.depletesAtMs != null && row.window.remainingFraction! > 0)
    .sort((left, right) => left.window.pace!.depletesAtMs! - right.window.pace!.depletesAtMs!
      || left.window.key.localeCompare(right.window.key))[0] : undefined;
  const range = pace?.empiricalRange
    ? t('usage.board.plans.rangeAtReset', {
        min: formatPlanPercent(pace.empiricalRange.min),
        max: formatPlanPercent(pace.empiricalRange.max),
        count: pace.sampleCount,
      })
    : null;
  const exactRange = pace?.empiricalRange ? t('usage.board.plans.rangeAtReset', {
    min: formatHappierDataExactShare(pace.empiricalRange.min, getPreferredLanguage()),
    max: formatHappierDataExactShare(pace.empiricalRange.max, getPreferredLanguage()), count: pace.sampleCount,
  }) : null;
  const rangeInk = range ? <Text testID={`${props.testID}.range`} accessibilityLabel={range} style={[styles.quiet, text.detail]}>{range}</Text> : null;
  const depletingStatement = depleting ? planWindowStatement(depleting.window, nowMs) : null;
  const depletingNote = depleting && depletingStatement ? (
    <NoticeLine
      testID={`${props.testID}.ahead`}
      iconName="warning"
      iconColor={theme.colors.state.danger.foreground}
      subject={`${depleting.name.title} · ${depleting.window.label}`}
      title={[
        depletingStatement.text,
        depletingStatement.kind === 'depletes' ? t('usage.board.plans.projectionBeforeReset') : null,
      ].filter(Boolean).join(' · ')}
    />
  ) : null;
  if (list) {
    // The list is where each live window lands. A used-up window has no projection left to make: its meter and its
    // return are Limits' and Resets', so here it is one count (acceptance 11-18 #7).
    // An older reading that is used up keeps its row, so the freshness owner's age stays beside it (J-B57); only
    // current used-up windows fold into the count.
    const live = rows.map(row => ({ ...row, statement: planWindowStatement(row.window, nowMs) }))
      .filter(row => row.statement.kind !== 'used_up' || row.window.paceUnavailable === 'stale');
    const spent = rows.length - live.length;
    const lead = leadingUsageRows(live, expanded);
    // One cause, said once: when every listed window lacks a projection for the same reason ("reading is
    // old"), the rows show their reset instead and the reason is one quiet line under the list.
    // A paced window behind Show all still disproves a whole-list missing-pace statement.
    const reasons = live.map(({ statement }) => statement.kind === 'unavailable' ? statement.text : null);
    const sharedReason = reasons.length > 1 && reasons[0] && reasons.every((reason) => reason === reasons[0]) ? reasons[0] : null;
    // When only some windows lack a projection and two or more share the cause, that cause is said once too:
    // under one line for the widget, never beneath every row.
    const repeatedReasons = new Map<string, number>();
    for (const reason of reasons) if (reason) repeatedReasons.set(reason, (repeatedReasons.get(reason) ?? 0) + 1);
    const [repeatedReason, repeatedCount] = sharedReason ? [null, 0]
      : [...repeatedReasons].sort((left, right) => right[1] - left[1]).find(([, count]) => count > 1) ?? [null, 0];
    const quietReason = sharedReason ?? repeatedReason;
    return (
      <View style={styles.body} testID={`${props.testID}.projections`}>
        {live.length ? (
          <UsageMeterStack testID={`${props.testID}.windows`}>
            {lead.rows.map((row) => (
              <ProjectionRow
                key={row.window.key}
                accountName={row.name.title}
                window={row.window}
                observedAtMs={row.account.observedAtMs}
                renderedAtMs={renderedAtMs}
                stacked={rowsStacked}
                resetOnly={!!quietReason && row.statement.kind === 'unavailable' && row.statement.text === quietReason}
                testID={`${props.testID}.window.${row.account.accountId}.${row.window.meterId}`}
              />
            ))}
          </UsageMeterStack>
        ) : null}
        <UsageShowAllRows label={t(`usage.widgets.${props.id}`)} testID={`${props.testID}.showAll`} total={live.length}
          hidden={lead.hidden} expanded={expanded} onToggle={() => setExpanded((value) => !value)}
          unlisted={unreported.length ? t('usage.board.plans.unreportedWindows', { count: unreported.length }) : null} />
        {/* Why windows have no projection and how many are used up are one footnote line, not a pile (r223 #51). */}
        {quietReason || spent > 0 ? (
          <Text style={[styles.quiet, text.detail]} testID={`${props.testID}.footnote`}>
            {quietReason ? (
              <Text testID={`${props.testID}.sharedReason`}>
                {sharedReason
                  ? t('usage.board.plans.paceSharedReason', { reason: sharedReason })
                  : t('usage.board.plans.paceSharedReasonSome', { count: repeatedCount, reason: quietReason })}
              </Text>
            ) : null}
            {quietReason && spent > 0 ? ' · ' : null}
            {spent > 0 ? (
              <Text testID={`${props.testID}.usedUp`}>{t('usage.board.plans.projectionsUsedUp', { count: spent })}</Text>
            ) : null}
          </Text>
        ) : null}
        {/* The run-out alert lands inside the body's remembered height; no line is held for one that may come. */}
        {depletingNote}
        {/* The legend explains pace marks; without any pace it explains nothing. */}
        {live.some(row => row.window.pace) ? <UsagePlanLegend testID={`${props.testID}.legend`} parts={[t('usage.board.plans.legendEvenPace'), t('usage.board.plans.legendHatched')]} /> : null}
        <UsagePlanAccountStates accounts={accounts} nameOf={nameOf} slice={props.slice} onRetry={props.model.refresh}
          replacesContent={!rows.length && !unreported.length && !depletingNote}
          promise={t('usage.board.plans.projectionsNoneConnected')}
          testID={`${props.testID}.state`} />
      </View>
    );
  }
  return (
    <View style={styles.body} testID={`${props.testID}.projections`}>
      {focus && focusName && pace ? (
        <View style={styles.chart}>
          {paced.length > 1 ? (
            <DropdownMenu
              testID={`${props.testID}.windowPicker`}
              open={pickerOpen}
              onOpenChange={open => { if (open !== pickerOpen) void windowCommands.invoke(open ? 'menuOpen' : 'menuClose'); }}
              selectedId={focus.window.key}
              matchTriggerWidth={false}
              items={pickerItems}
              onSelect={chooseWindow}
              trigger={({ toggle, open }) => (
                <HappierPressable
                  testID={`${props.testID}.windowPicker.trigger`}
                  onPress={toggle}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('usage.board.plans.windowPicker')}: ${focusTitle}`}
                  expanded={open}
                  style={(state) => [
                    styles.picker,
                    state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                  ]}
                >
                  <Text style={[styles.chartTitle, text.title]} numberOfLines={1}>
                    {focusTitle}
                  </Text>
                  <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
                </HappierPressable>
              )}
            />
          ) : (
            <Text style={[styles.chartTitle, text.title]} numberOfLines={1}>
              {focusTitle}
            </Text>
          )}
          <ProjectionHeadline
            window={focus.window}
            nowMs={nowMs}
            testID={`${props.testID}.headline`}
          />
          <BurnUpChart
            {...details}
            testID={`${props.testID}.burnUp`}
            theme={chartTheme}
            size={tile ? 'tile' : 'full'}
            {...(tile ? {} : { viewportHeight: stacked ? 120 : 150 })}
            label={focusTitle}
            series={series}
            bands={pace.empiricalRange ? EMPIRICAL_BAND : undefined}
            minimumMaximum={100}
            reference={{ value: 100, label: t('usage.board.plans.burnLimit') }}
            valueFormatter={(value) => `${Math.round(value)}%`}
            unknownLabel={t('usage.board.plans.cellUnknown')}
            valuesLabel={`${focusTitle}: ${t('usage.board.charts.showValues')}`}
            valuesCollapseLabel={t('usage.board.charts.hideValues')}
            coordinateFormatter={value => new Date(value).toISOString()}
            renderBucket={(bucket, visual) => <ChartDatum datum={{ keyboard: false, label: focusTitle,
              value: describeHappierSeriesBucket(bucket, t('usage.board.plans.cellUnknown'), {
                formatCoordinate: value => new Date(value).toISOString(),
                formatValue: value => `${formatHappierDataValue(value, getPreferredLanguage())}%`,
              }) }}><View style={{ height: '100%' }}>{visual}</View></ChartDatum>}
            // The range is said once, by its own line under the chart.
            summary={planWindowStatement(focus.window, nowMs).text}
            showAxis={!tile}
            showScaleValues={!tile}
            showLegend={!tile}
            {...(axisTicks ? { axisTicks } : {})}
            showReadout={false}
          />
          {range && exactRange && exactRange !== range ? <ChartDatum testID={`${props.testID}.range.detail`}
            datum={{ keyboard: false, label: focusTitle, value: exactRange }}>{rangeInk}</ChartDatum> : rangeInk}
          {earlier && !tile ? (
            <Text
              testID={`${props.testID}.earlier`}
              accessibilityLabel={earlierCurvesText(earlier)}
              style={[styles.quiet, text.detail]}
            >
              {earlierCurvesText(earlier)}
            </Text>
          ) : null}
        </View>
      ) : !settled ? (
        // Which window leads is not known until every first read answers: the chart's room, not a "no pace" claim.
        <UsageBodyReading testID={`${props.testID}.reading`} shape={{ kind: 'chart', plotPx: stacked ? 120 : 150 }}
          waitingOn={{ slice: props.slice, sources: ['quota'] }} />
      ) : !onlyUnread ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.noPace`}
          replacesContent={rows.length === 0}
          title={t('usage.board.plans.noPaceAnywhere')}
          reason={t('usage.board.plans.noPaceAnywhereReason')}
        />
      ) : null}
      {!tile && props.query.granularity !== 'hour' ? <UsageDailyQuotaHistory accounts={projection.accounts} nameOf={nameOf}
        testID={`${props.testID}.dailyHistory`} /> : null}
      {rows.length ? <UsagePlanDisclosure testID={`${props.testID}.reported`}
        title={t('usage.board.plans.reportedWindows', { count: rows.length })}>
      {!tile && focus && paced.length > 1 ? (
        <View style={styles.multiples} testID={`${props.testID}.multiples`} accessibilityRole="list">
          {paced.map((entry) => (
            <SmallMultipleControl
              key={entry.window.key}
              window={entry.window}
              accountName={nameOf(entry.account).title}
              selected={entry.window.key === focus.window.key}
              renderedAtMs={renderedAtMs}
              color={accent}
              basis={stacked ? '47%' : '31%'}
              onPick={chooseWindow}
              controlId={`${props.testID}.multiple.${entry.account.accountId}.${entry.window.meterId}`}
            />
          ))}
        </View>
      ) : null}
      {(
        <UsageMeterStack testID={`${props.testID}.windows`}>
          {rows.map((row) => (
            <ProjectionRow
              key={row.window.key}
              accountName={row.name.title}
              window={row.window}
              observedAtMs={row.account.observedAtMs}
              renderedAtMs={renderedAtMs}
              stacked={rowsStacked}
              testID={`${props.testID}.window.${row.account.accountId}.${row.window.meterId}`}
            />
          ))}
        </UsageMeterStack>
      )}
      </UsagePlanDisclosure> : null}
      {unreported.length ? <UsagePlanDisclosure testID={`${props.testID}.unreported`}
        title={t('usage.board.plans.unreportedWindows', { count: unreported.length })}>
        <UsageMeterStack testID={`${props.testID}.unreported.windows`}>
          {unreported.map(row => <ProjectionRow key={row.window.key} accountName={row.name.title}
            window={row.window} observedAtMs={row.account.observedAtMs} renderedAtMs={renderedAtMs} stacked={rowsStacked}
            testID={`${props.testID}.window.${row.account.accountId}.${row.window.meterId}`} />)}
        </UsageMeterStack>
      </UsagePlanDisclosure> : null}
      {!tile && focus && focusName ? (
        <UsagePlanDisclosure loadExactHistory
          testID={`${props.testID}.pastCycles`}
          title={t('usage.board.plans.pastCyclesTitle')}
          meta={focusTitle}
        >
          <PastCycles account={focus.account} window={focus.window} nowMs={nowMs} testID={`${props.testID}.pastCycles`} />
        </UsagePlanDisclosure>
      ) : null}
      {depletingNote}
      {targetNote ? (
        <Text style={[styles.targetNote, text.detail]} testID={`${props.testID}.target`}>{targetNote}</Text>
      ) : null}
      {tile || !rows.some(row => row.window.pace) ? null : (
        <UsagePlanLegend
          testID={`${props.testID}.legend`}
          parts={[
            t('usage.board.plans.legendEvenPace'),
            t('usage.board.plans.legendHatched'),
          ]}
        />
      )}
      <UsagePlanAccountStates accounts={accounts} nameOf={nameOf} slice={props.slice}
        onRetry={props.model.refresh} testID={`${props.testID}.state`} replacesContent={onlyUnread}
        promise={t('usage.board.plans.projectionsNoneConnected')} />
    </View>
  );
}

/**
 * Where this pace lands, said once: the share used at the reset, or the time it runs out. It is always
 * an estimate and says how many readings it stands on; only "runs out before the reset" is red.
 */
function ProjectionHeadline(props: Readonly<{ window: UsagePlanWindow; nowMs: number; testID: string }>) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const text = usePlanText();
  const statement = planWindowStatement(props.window, props.nowMs);
  if (statement.kind === 'used_up') {
    return <HappierDataMetric testID={props.testID} theme={chartTheme} size="stat"
      label={t('usage.board.plans.cellUsedUp')} showLabel
      value={props.window.resetAtMs === null ? t('usage.board.plans.cellUsedUp')
        : t('usage.board.plans.excludedBack', { time: formatMoment(props.window.resetAtMs, props.nowMs) })} />;
  }
  const pace = props.window.pace!;
  const basis = [
    t('usage.board.plans.estimatedFrom', { count: pace.sampleCount }),
    pace.qualification === 'estimated' ? t('usage.board.plans.projectionProviderEstimate') : null,
    props.window.resetAtMs !== null
      ? t('usage.board.plans.capacityResets', { time: formatMoment(props.window.resetAtMs, props.nowMs) })
      : null,
  ].filter(Boolean).join(' · ');
  const runsOut = pace.depletesAtMs !== null;
  const projectedPercent = Math.round(pace.projectedUsedFraction * 100);
  const value = runsOut ? formatMoment(pace.depletesAtMs!, props.nowMs) : `~${projectedPercent}%`;
  const label = t(runsOut ? 'usage.board.plans.projectionRunsOutLabel' : 'usage.board.plans.projectionUsedAtReset');
  const exact = runsOut ? new Intl.DateTimeFormat(getPreferredLanguage(), { dateStyle: 'full', timeStyle: 'long' }).format(pace.depletesAtMs!)
    : formatHappierDataExactShare(pace.projectedUsedFraction, getPreferredLanguage());
  const hasExactTooltip = runsOut || exact !== `${projectedPercent}%`;
  const figure = <HappierDataMetric testID={props.testID} theme={chartTheme} size="stat"
    label={label} value={runsOut ? value : projectedPercent}
    {...(runsOut ? {} : { valueFormatter: () => value })} showLabel caption={basis} decorative={hasExactTooltip} />;
  return (
    <View style={styles.headline}>
      {hasExactTooltip ? <>
        <Text style={visuallyHiddenStyle}>{[value, label, basis].filter(Boolean).join(' · ')}</Text>
        <ChartDatum testID={`${props.testID}.detail`} datum={{ keyboard: false, label: props.window.label, value: exact, subtitle: basis }}>{figure}</ChartDatum>
      </> : figure}
      {runsOut ? (
        <NoticeLine
          testID={`${props.testID}.beforeReset`}
          iconName="warning"
          iconColor={theme.colors.state.danger.foreground}
          title={t('usage.board.plans.projectionBeforeReset')}
        />
      ) : null}
    </View>
  );
}

/** One window's own burn-up at tile size; pressing it makes it the charted window. */
const SmallMultipleControl = React.memo(function SmallMultipleControl(
  props: Readonly<{
    window: UsagePlanWindow;
    accountName: string;
    selected: boolean;
    renderedAtMs: number;
    color: string;
    basis: `${number}%`;
    onPick: (key: string) => void;
    controlId: string;
  }>,
) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const { window } = props;
  const nowMs = Date.now();
  const title = `${props.accountName} · ${window.label}`;
  const statement = planWindowStatement(window, nowMs);
  const key = window.key;
  const onPick = props.onPick;
  const pick = React.useCallback(() => onPick(key), [onPick, key]);
  return (
    <HappierPressable
      testID={props.controlId}
      onPress={pick}
      accessibilityRole="button"
      accessibilityLabel={[title, statement.text].join(', ')}
      selected={props.selected}
      style={(state) => [
        styles.multiple,
        { flexBasis: props.basis },
        state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
      ]}
    >
      <Text style={[props.selected ? styles.chartTitle : styles.multipleTitle, text.detail]} numberOfLines={1}>
        {title}
      </Text>
      <SmallMultiple window={window} title={title} renderedAtMs={props.renderedAtMs} color={props.color} testID={props.controlId} />
      <Text
        style={[styles.quiet, text.detail, statement.tone === 'warning' ? styles.danger : null]}
        numberOfLines={1}
      >
        {statement.text}
      </Text>
    </HappierPressable>
  );
});

// Selection updates the control without resampling the time of an unchanged series.
const SmallMultiple = React.memo(function SmallMultiple(
  props: Readonly<{ window: UsagePlanWindow; title: string; renderedAtMs: number; color: string; testID: string }>,
) {
  const chartTheme = useUsagePluginTheme();
  const { window, title, renderedAtMs, color } = props;
  const series = React.useMemo(
    () => buildBurnUp(window, renderedAtMs, { observed: t('usage.board.plans.burnObserved'), projected: t('usage.board.plans.burnProjected') },
      { line: color, range: color }),
    [window, renderedAtMs, color],
  );
  return (
    <BurnUpChart
      decorative
      testID={`${props.testID}.chart`}
      theme={chartTheme}
      size="tile"
      label={title}
      series={series}
      minimumMaximum={100}
      valueFormatter={(value) => `${Math.round(value)}%`}
      unknownLabel={t('usage.board.plans.cellUnknown')}
      summary={planWindowStatement(window, renderedAtMs).text}
      showAxis={false}
      showLegend={false}
      showReadout={false}
    />
  );
});

/** The charted window's ended cycles, each row as the B owner recorded it. Mounted only while disclosed. */
function PastCycles(props: Readonly<{ account: UsagePlanAccount; window: UsagePlanWindow; nowMs: number; testID: string }>) {
  const text = usePlanText();
  const past = projectUsagePastCycles(props.account, props.window.meterId);
  if (past.reason !== null) {
    return (
      <Text testID={`${props.testID}.none`} style={[styles.quiet, text.detail]}>
        {t(
          past.reason === 'not_loaded'
            ? 'usage.board.plans.pastCyclesNotLoaded'
            : past.reason === 'unavailable'
              ? 'usage.board.plans.pastCyclesUnavailable'
              : 'usage.board.plans.pastCyclesNoneEnded',
        )}
      </Text>
    );
  }
  return (
    <View style={styles.cycles} accessibilityRole="list">
      {past.cycles.map((cycle, index) => (
        <PastCycleRow key={cycle.key} cycle={cycle} nowMs={props.nowMs} testID={`${props.testID}.row.${index}`} />
      ))}
      {past.partial ? (
        <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.endedUnusedPartial')}</Text>
      ) : null}
    </View>
  );
}

function PastCycleRow(props: Readonly<{ cycle: UsagePlanPastCycle; nowMs: number; testID: string }>) {
  const text = usePlanText();
  const { cycle } = props;
  const ended = t('usage.board.plans.pastCycleEnded', {
    time: new Date(cycle.resetAtMs).toLocaleDateString([], { day: 'numeric', month: 'short' }),
  });
  const value = cycle.value;
  const detail =
    value.status === 'available'
      ? [
          t('usage.board.plans.pastCycleUsed', { percent: formatPlanPercent(value.usedFraction) }),
          t(value.qualification === 'estimated' ? 'usage.board.plans.pastCycleUnusedEstimated' : 'usage.board.plans.pastCycleUnused', {
            amount: formatHappierDataValue(value.unusedAmount),
            unit: value.unit,
          }),
          t(value.method === 'terminal_observation' ? 'usage.board.plans.pastCycleAtReset' : 'usage.board.plans.pastCycleLinear'),
          t('usage.board.plans.estimatedFrom', { count: value.sampleCount }),
        ].join(' · ')
      : t('usage.board.plans.pastCycleNotMeasured', { reason: planPaceReasonText(value.reason) });
  const visual = (
    <View testID={props.testID} style={styles.cycle} accessible accessibilityLabel={`${ended}, ${detail}${value.status === 'available' ? ` · ${formatHappierDataExactShare(value.usedFraction, getPreferredLanguage())}` : ''}`}>
      <Text style={[styles.cycleWhen, text.detail]} numberOfLines={1}>
        {ended}
      </Text>
      <View style={styles.cycleBody}>
        {value.status === 'available' ? (
          <MeterBar height={4} tone="neutral" fillFraction={Math.min(1, value.usedFraction)}
            {...(value.qualification === 'estimated' ? { fillOpacity: 0.45 } : {})} />
        ) : null}
        <Text style={[styles.quiet, text.detail]} numberOfLines={2}>
          {detail}
        </Text>
      </View>
    </View>
  );
  const exact = value.status === 'available' ? formatHappierDataExactShare(value.usedFraction, getPreferredLanguage()) : null;
  return exact !== null && value.status === 'available' && formatPlanPercent(value.usedFraction) !== exact
    ? <ChartDatum testID={`${props.testID}.detail`} datum={{ keyboard: false, label: ended, value: exact, subtitle: detail }}>{visual}</ChartDatum> : visual;
}

const ProjectionRow = React.memo(function ProjectionRow(
  props: Readonly<{
    accountName: string;
    window: UsagePlanWindow;
    observedAtMs: number | null;
    renderedAtMs: number;
    stacked: boolean;
    /** The list says the missing projection once; this row then shows its reset countdown. */
    resetOnly?: boolean;
    testID: string;
  }>,
) {
  const { window } = props;
  // The parent passes its render instant so an ordinary render refreshes this
  // caption even when the window is unchanged. Expiry renders only this row.
  const nowMs = Date.now();
  const statement = planWindowStatement(window, nowMs);
  const label = `${props.accountName} · ${window.label}`;
  const text = usePlanText();
  const expired = window.paceUnavailable === 'stale';
  const statusText = !props.resetOnly && statement.kind === 'unavailable' || statement.kind === 'used_up' ? statement.text : null;
  // One kind of fact per row (acceptance 11-22 #40): the column says where this pace lands and nothing else; when the
  // window resets, and why it has no projection, are its caption.
  const projected = !expired && (statement.kind === 'at_reset' || statement.kind === 'depletes');
  // Used up already says when it comes back; its reset is not said twice.
  const caption = [statement.kind === 'used_up' ? null : formatPlanResetPhrase(window.resetAtMs, nowMs), statusText]
    .filter(Boolean).join(' · ');
  const projection = projected ? statement.text : '';
  const locale = getPreferredLanguage();
  const exact = window.remainingFraction === null ? null : formatHappierDataExactShare(window.remainingFraction, locale);
  const value = exact === null ? t('common.unavailable') : t('usage.board.plans.cellLeft', { percent: exact });
  const reported = window.estimated && exact !== null ? t('connectedServicesCollection.meterEstimated', { value }) : value;
  const captionReading = expired
    ? resolveHappierFreshnessText({
        asOf: props.observedAtMs,
        reason: caption,
        formatAsOf: (time) => t('surfaceState.asOf', { time }),
        locale,
      })
    : caption;
  const visual = (
    <UsageMeterRow
      testID={props.testID}
      label={label}
      remainingPct={
        window.remainingFraction === null
          ? null
          : window.remainingFraction * 100
      }
      resetsAt={null}
      tone={expired ? 'neutral' : window.tone}
      now={nowMs}
      estimated={window.estimated}
      size={props.stacked ? 'default' : 'wide'}
      layout={props.stacked ? 'stacked' : 'inline'}
      resetText={projection}
      {...(window.pace
        ? {
            pace: {
              evenPaceRemainingFraction: window.pace.evenPaceRemainingFraction,
              projectedRemainingFraction:
                window.pace.projectedRemainingFraction,
            },
          }
        : {})}
    />
  );
  const row = exact === null || !window.pace && formatPlanPercent(window.remainingFraction!).includes(exact) ? visual
    : <ChartDatum testID={`${props.testID}.datum`} datum={{ keyboard: false, label, value,
      subtitle: [window.pace ? t('usage.board.plans.estimatedFrom', { count: window.pace.sampleCount }) : null,
        window.pace ? `${t('usage.board.plans.projectionUsedAtReset')} · ${formatHappierDataExactShare(window.pace.projectedUsedFraction, locale)}` : null,
        window.resetAtMs === null ? null : formatMoment(window.resetAtMs, nowMs), statusText].filter(Boolean).join(' · ') }}>
      <View>{visual}</View>
    </ChartDatum>;
  // The exact tooltip is pointer-only. Expose one reading for the meter and its caption in either row shape.
  return <View accessible role="group" accessibilityLabel={[label, reported, projection, captionReading].filter(Boolean).join(' · ')}>
    <View style={styles.windowRow} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {row}
      {expired ? <SurfaceFreshnessLine testID={`${props.testID}.freshness`} presentation="inline" asOf={props.observedAtMs} reason={caption} />
        : caption ? <Text testID={`${props.testID}.caption`} style={[styles.quiet, text.detail]} numberOfLines={1}>{caption}</Text> : null}
    </View>
  </View>;
});

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16 },
  chart: { gap: theme.space.s10 },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space.s6,
    maxWidth: '100%',
    borderRadius: theme.borderRadius.sm,
  },
  chartTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  headline: { gap: theme.space.s4 },
  windowRow: { gap: theme.space.s2 },
  quiet: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  danger: { color: theme.colors.state.danger.textForeground },
  multiples: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: 14 },
  multiple: { flexGrow: 1, minWidth: 0, gap: theme.space.s6, borderRadius: theme.borderRadius.sm },
  multipleTitle: { ...Typography.default('medium'), color: theme.colors.text.secondary },
  cycles: { gap: theme.space.s10 },
  cycle: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s12 },
  cycleWhen: {
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
    width: 96,
  },
  cycleBody: { flex: 1, minWidth: 0, gap: theme.space.s4 },
  targetNote: { ...Typography.default(), color: theme.colors.text.secondary },
}));
