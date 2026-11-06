import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  BurnUpChart,
  ChartDatum,
  formatHappierDataExactShare,
  formatHappierDataValue,
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierDataMetric,
  HappierPressable,
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
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useUsageChartDetails } from './usageMountedControls';
import { usageSignatureAccent } from '../usageAccent';
import {
  leadingUsageRows,
  useSettledBodyHeightFloor,
  useUsageMeterListFirstReadReserve,
  UsageBodyInsufficient,
  UsageShowAllRows,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import {
  projectUsageEarlierCurves,
  projectUsagePastCycles,
  selectUsagePacedWindows,
  type UsagePlanAccount,
  type UsagePlanPastCycle,
  type UsagePlanWindow,
} from './plans/usagePlansModel';
import {
  useUsagePlans,
  type UsagePlanAccountName,
} from './plans/useUsagePlans';
import {
  formatPlanMoment,
  formatPlanPercent,
  planPaceReasonText,
  planWindowStatement,
  UsagePlanDisclosure,
  UsagePlanLegend,
  UsagePlanAccountStates,
  UsagePlansNothingRead,
  readPendingPlanAccountCount,
  readUsageKnownQuotaAccountCount,
  usePlanText,
} from './plans/UsagePlanParts';
import { readUsagePersonalPaceTarget, selectUsageWindowsAboveTarget } from './plans/usagePacingTarget';

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
  focus: Focus,
  nowMs: number,
  labels: ChartLabels | Pick<ChartLabels, 'observed' | 'projected'>,
  colors: Readonly<{ line: string; range: string }>,
  earlier?: Readonly<{ curves: EarlierCurves; color: string }>,
): HappierSeries[] {
  const pace = focus.window.pace!;
  const point = (x: number, y: number) => ({ id: `t${x}`, x, y, label: formatPlanMoment(x, nowMs) });
  const observedPoints = pace.observedCurve.map((sample) => point(sample.observedAtMs, sample.usedFraction * 100));
  const last = observedPoints.at(-1);
  const series: HappierSeries[] = [
    { id: 'observed', label: labels.observed, color: colors.line, points: observedPoints },
  ];
  const resetAtMs = focus.window.resetAtMs;
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
    const ended = formatPlanMoment(curve.window.resetAtMs, nowMs);
    series.push({
      id: `earlier:${curve.window.resetAtMs}`,
      // One look, one key: the legend shows "Earlier windows" once; each point still names its window.
      label: t('usage.board.plans.earlierCurves'),
      color: earlier!.color,
      points: curve.points.map((sample, index) => {
        const x = Math.round(pace.windowStartAtMs + sample.elapsedFraction * curve.window.windowDurationMs);
        return { id: `earlier:${curve.window.resetAtMs}:${index}`, x, y: sample.usedFraction * 100,
          label: `${formatPlanMoment(x, nowMs)} · ${t('usage.board.plans.earlierCurve', { time: ended })}` };
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
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const text = usePlanText();
  const presentation = useWidgetPresentation();
  const width = presentation?.geometry?.width ?? null;
  const tile = presentation?.size === 'small';
  // Beside other widgets (Medium, Wide) Projections is the lab's Limits list (`wgusage-CD`): one meter
  // per reported window with its projection, no burn-up, no disclosures. Its own view keeps the chart.
  const list = presentation?.size === 'medium' || presentation?.size === 'wide';
  const { projection, nameOf, nowMs } = useUsagePlans(props.slice, props.model.refresh);
  useWidgetFrameBodyCaption(t('usage.board.plans.projectionsCaption'));
  const settled = projection.accounts.length > 0 && readPendingPlanAccountCount(projection.accounts) === 0;
  const paced = React.useMemo(() => settled ? [...selectUsagePacedWindows(projection.accounts)]
    .sort((left, right) => left.window.key.localeCompare(right.window.key)) : [], [projection.accounts, settled]);
  // The viewer's pick, kept by window identity; a window that stops having a pace falls back to the default.
  const [pickedKey, setPickedKey] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const focus = React.useMemo(
    () => paced.find((entry) => entry.window.key === pickedKey) ?? pickDefaultFocus(paced, projection.tightest),
    [paced, pickedKey, projection.tightest],
  );
  const accent = usageSignatureAccent(theme);
  const rangeColor = theme.colors.text.tertiary;
  const ghostColor = theme.colors.border.default;
  const earlier = React.useMemo(
    () => (focus && !list ? projectUsageEarlierCurves(focus.account, focus.window.meterId) : null),
    [focus, list],
  );
  const series = React.useMemo(
    () =>
      focus && !list
        ? buildBurnUp(
            focus,
            nowMs,
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
    [focus, nowMs, accent, rangeColor, earlier, tile, ghostColor, list],
  );
  // Ghost points join the plot after the current ones, so the axis names the plot's real first and last moment.
  const axisTicks = React.useMemo(() => {
    if (!series.some((entry) => entry.id.startsWith('earlier:'))) return null;
    const xs = series.flatMap((entry) => entry.points.map((point) => Number(point.x)));
    return [formatPlanMoment(Math.min(...xs), nowMs), formatPlanMoment(Math.max(...xs), nowMs)];
  }, [series, nowMs]);
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
  }, [paced]);
  useCurrentUiContextLocalCommands(!list && paced.length > 1 ? pickerItems.map(item => ({
    key: item.id, title: `${t(`usage.widgets.${props.id}`)}: ${t('usage.board.plans.windowPicker')}: ${item.title}`,
    invoke: () => selectWindow(item.id),
  })) : []);
  const details = useUsageChartDetails(t(`usage.widgets.${props.id}`), !list && Boolean(focus?.window.pace));
  // Beside other widgets the body is a list of meters. Until every account has answered once it holds the
  // list's room (the rows its accounts are expected to report, the pace alert and the notes under them), so
  // reads fill the room instead of growing the page under the reader; a re-read after that never reserves.
  const firstReadReserve = useUsageMeterListFirstReadReserve(props.slice, readUsageKnownQuotaAccountCount(props.slice),
    settled, width !== null && width < STACKED_BELOW_PX);
  const reserve = list ? firstReadReserve : undefined;
  const readingShape = reserve?.shape;
  // After that settle, every re-read swaps the pace alert / shared reason / legend: they do so inside the
  // height the list has already shown, so the cards beside and below it never move.
  const floor = useSettledBodyHeightFloor(list && settled, `${expanded}:${width !== null && width < STACKED_BELOW_PX}`);
  const bodyStyle = reserve ? [styles.body, { minHeight: reserve.minHeight }]
    : floor.minHeight !== undefined ? [styles.body, { minHeight: floor.minHeight }] : styles.body;
  if (projection.accounts.length === 0) {
    return (
      <View style={bodyStyle}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          slice={props.slice}
          promise={t('usage.board.plans.projectionsNoneConnected')}
          {...(readingShape ? { readingShape } : {})}
          onRetry={props.model.refresh}
        />
      </View>
    );
  }
  const stacked = width !== null && width < STACKED_BELOW_PX;
  // The viewer's own advice target, as echoed by the same allowance read (lab `p2budget`).
  const target = readUsagePersonalPaceTarget(props.slice.quota?.[0]?.targets ?? []);
  const above = target === null ? [] : selectUsageWindowsAboveTarget(
    projection.accounts.map((account) => ({ title: nameOf(account).title, windows: account.windows })),
    target,
  );
  const targetNote = target === null ? null
    : above.length > 0
      ? t('usage.board.plans.targetAbove', { percent: Math.round(target * 100), windows: above.join(', ') })
      : t('usage.board.plans.targetWithin', { percent: Math.round(target * 100) });
  const windows = projection.accounts.flatMap(account => account.windows
    .map(window => ({ account, window, name: nameOf(account) })));
  const rows = windows.filter(row => row.window.remainingFraction !== null);
  const unreported = windows.filter(row => row.window.remainingFraction === null);
  const focusName = focus ? nameOf(focus.account) : null;
  const focusTitle = focus && focusName ? `${focusName.title} · ${focus.window.label}` : '';
  const pace = focus?.window.pace ?? null;
  const depleting = settled ? rows.filter(row => row.window.pace?.depletesAtMs != null)
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
  const depletingNote = depleting ? (
    <NoticeLine
      testID={`${props.testID}.ahead`}
      iconName="warning"
      iconColor={theme.colors.state.danger.foreground}
      subject={`${depleting.name.title} · ${depleting.window.label}`}
      title={[
        t('usage.board.plans.projectionRunsOut', {
          time: formatPlanMoment(depleting.window.pace!.depletesAtMs!, nowMs),
        }),
        t('usage.board.plans.projectionBeforeReset'),
      ].join(' · ')}
    />
  ) : null;
  if (list) {
    const lead = leadingUsageRows(rows, expanded);
    // One cause, said once: when every listed window lacks a projection for the same reason ("reading is
    // old"), the rows show their reset instead and the reason is one quiet line under the list.
    // A paced window behind Show all still disproves a whole-list missing-pace statement.
    const reasons = rows.map((row) => (row.window.pace ? null : planWindowStatement(row.window, nowMs).text));
    const sharedReason = reasons.length > 1 && reasons[0] && reasons.every((reason) => reason === reasons[0]) ? reasons[0] : null;
    // When only some windows lack a projection and two or more share the cause, that cause is said once too:
    // under one line for the widget, never beneath every row.
    const repeatedReasons = new Map<string, number>();
    for (const reason of reasons) if (reason) repeatedReasons.set(reason, (repeatedReasons.get(reason) ?? 0) + 1);
    const [repeatedReason, repeatedCount] = sharedReason ? [null, 0]
      : [...repeatedReasons].sort((left, right) => right[1] - left[1]).find(([, count]) => count > 1) ?? [null, 0];
    const quietReason = sharedReason ?? repeatedReason;
    return (
      <View style={bodyStyle} onLayout={floor.onLayout} testID={`${props.testID}.projections`}>
        {rows.length ? (
          <UsageMeterStack testID={`${props.testID}.windows`}>
            {lead.rows.map((row) => (
              <ProjectionRow
                key={row.window.key}
                name={row.name}
                window={row.window}
                nowMs={nowMs}
                stacked={stacked}
                {...(quietReason && !row.window.pace && planWindowStatement(row.window, nowMs).text === quietReason ? { resetOnly: true } : {})}
                testID={`${props.testID}.window.${row.account.accountId}.${row.window.meterId}`}
              />
            ))}
          </UsageMeterStack>
        ) : null}
        {quietReason ? (
          <Text style={[styles.quiet, text.detail]} testID={`${props.testID}.sharedReason`}>
            {sharedReason
              ? t('usage.board.plans.paceSharedReason', { reason: sharedReason })
              : t('usage.board.plans.paceSharedReasonSome', { count: repeatedCount, reason: quietReason })}
          </Text>
        ) : null}
        <UsageShowAllRows label={t(`usage.widgets.${props.id}`)} testID={`${props.testID}.showAll`} total={rows.length}
          hidden={lead.hidden} expanded={expanded} onToggle={() => setExpanded((value) => !value)}
          unlisted={unreported.length ? t('usage.board.plans.unreportedWindows', { count: unreported.length }) : null} />
        {/* A window still without a pace may gain one and run out while reads arrive: the alert's line is held
            until they settle, then let go, so a list that never gets an alert keeps no blank line. */}
        {depletingNote ?? (!settled && rows.some(row => !row.window.pace)
          ? <View style={{ minHeight: text.detail.lineHeight * (stacked ? 2 : 1) }} testID={`${props.testID}.aheadRoom`} /> : null)}
        {/* The legend explains pace marks; without any pace it explains nothing. */}
        {rows.some(row => row.window.pace) ? <UsagePlanLegend testID={`${props.testID}.legend`} parts={[t('usage.board.plans.legendEvenPace'), t('usage.board.plans.legendHatched')]} /> : null}
        <UsagePlanAccountStates accounts={projection.accounts} nameOf={nameOf} slice={props.slice} onRetry={props.model.refresh}
          replacesContent={!rows.length && !unreported.length && !depletingNote}
          {...(readingShape ? { readingShape } : {})}
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
              onOpenChange={setPickerOpen}
              selectedId={focus.window.key}
              matchTriggerWidth={false}
              items={pickerItems}
              onSelect={selectWindow}
              trigger={({ toggle, open }) => (
                <HappierPressable
                  testID={`${props.testID}.windowPicker.trigger`}
                  onPress={toggle}
                  accessibilityRole="button"
                  accessibilityLabel={`${t('usage.board.plans.windowPicker')}: ${focusTitle}`}
                  expanded={open}
                  hitSlop={10}
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
            unknownLabel="—"
            valuesLabel={t('usage.showAll')}
            valuesCollapseLabel={t('usage.showLess')}
            summary={[planWindowStatement(focus.window, nowMs).text, range].filter(Boolean).join(' · ')}
            showAxis={!tile}
            showScaleValues={!tile}
            showLegend={!tile}
            {...(axisTicks ? { axisTicks } : {})}
            showReadout={false}
          />
          {range && exactRange && exactRange !== range ? <ChartDatum testID={`${props.testID}.range.detail`}
            datum={{ label: focusTitle, value: exactRange }}>{rangeInk}</ChartDatum> : rangeInk}
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
      ) : (
        <UsageBodyInsufficient
          testID={`${props.testID}.noPace`}
          replacesContent={rows.length === 0}
          title={t('usage.board.plans.noPaceAnywhere')}
          reason={t('usage.board.plans.noPaceAnywhereReason')}
        />
      )}
      {rows.length ? <UsagePlanDisclosure testID={`${props.testID}.reported`}
        title={t('usage.board.plans.reportedWindows', { count: rows.length })}>
      {!tile && focus && paced.length > 1 ? (
        <View style={styles.multiples} testID={`${props.testID}.multiples`} accessibilityRole="list">
          {paced.map((entry) => (
            <SmallMultiple
              key={entry.window.key}
              entry={entry}
              name={nameOf(entry.account)}
              selected={entry.window.key === focus.window.key}
              nowMs={nowMs}
              color={accent}
              basis={stacked ? '47%' : '31%'}
              onPick={selectWindow}
              testID={`${props.testID}.multiple.${entry.account.accountId}.${entry.window.meterId}`}
            />
          ))}
        </View>
      ) : null}
      {(
        <UsageMeterStack testID={`${props.testID}.windows`}>
          {rows.map((row) => (
            <ProjectionRow
              key={row.window.key}
              name={row.name}
              window={row.window}
              nowMs={nowMs}
              stacked={stacked}
              testID={`${props.testID}.window.${row.account.accountId}.${row.window.meterId}`}
            />
          ))}
        </UsageMeterStack>
      )}
      </UsagePlanDisclosure> : null}
      {unreported.length ? <UsagePlanDisclosure testID={`${props.testID}.unreported`}
        title={t('usage.board.plans.unreportedWindows', { count: unreported.length })}>
        <UsageMeterStack testID={`${props.testID}.unreported.windows`}>
          {unreported.map(row => <ProjectionRow key={row.window.key} name={row.name}
            window={row.window} nowMs={nowMs} stacked={stacked}
            testID={`${props.testID}.window.${row.account.accountId}.${row.window.meterId}`} />)}
        </UsageMeterStack>
      </UsagePlanDisclosure> : null}
      {!tile && focus && focusName ? (
        <UsagePlanDisclosure
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
      <UsagePlanAccountStates accounts={projection.accounts} nameOf={nameOf} slice={props.slice}
        onRetry={props.model.refresh} testID={`${props.testID}.state`} />
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
  const pace = props.window.pace!;
  const basis = [
    t('usage.board.plans.estimatedFrom', { count: pace.sampleCount }),
    pace.qualification === 'estimated' ? t('usage.board.plans.projectionProviderEstimate') : null,
    props.window.resetAtMs !== null
      ? t('usage.board.plans.capacityResets', { time: formatPlanMoment(props.window.resetAtMs, props.nowMs) })
      : null,
  ].filter(Boolean).join(' · ');
  const runsOut = pace.depletesAtMs !== null;
  const figure = <HappierDataMetric testID={props.testID} theme={chartTheme} size="stat"
    label={runsOut ? t('usage.board.plans.projectionRunsOutLabel') : t('usage.board.plans.projectionUsedAtReset')}
    value={runsOut ? formatPlanMoment(pace.depletesAtMs!, props.nowMs) : Math.round(pace.projectedUsedFraction * 100)}
    {...(runsOut ? {} : { valueFormatter: (value: number) => `~${value}%` })} showLabel caption={basis} />;
  const exact = runsOut ? new Intl.DateTimeFormat(getPreferredLanguage(), { dateStyle: 'full', timeStyle: 'long' }).format(pace.depletesAtMs!)
    : formatHappierDataExactShare(pace.projectedUsedFraction, getPreferredLanguage());
  return (
    <View style={styles.headline}>
      {runsOut || exact !== `${Math.round(pace.projectedUsedFraction * 100)}%`
        ? <ChartDatum testID={`${props.testID}.detail`} datum={{ label: props.window.label, value: exact, subtitle: basis }}>{figure}</ChartDatum> : figure}
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
function SmallMultiple(
  props: Readonly<{
    entry: Focus;
    name: UsagePlanAccountName;
    selected: boolean;
    nowMs: number;
    color: string;
    basis: `${number}%`;
    onPick: (key: string) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const text = usePlanText();
  const { entry, nowMs, color } = props;
  const title = `${props.name.title} · ${entry.window.label}`;
  const statement = planWindowStatement(entry.window, nowMs);
  const series = React.useMemo(
    () => buildBurnUp(entry, nowMs, { observed: t('usage.board.plans.burnObserved'), projected: t('usage.board.plans.burnProjected') },
      { line: color, range: color }),
    [entry, nowMs, color],
  );
  const key = entry.window.key;
  const onPick = props.onPick;
  const pick = React.useCallback(() => onPick(key), [onPick, key]);
  return (
    <HappierPressable
      testID={props.testID}
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
      <BurnUpChart
        theme={chartTheme}
        size="tile"
        label={title}
        series={series}
        minimumMaximum={100}
        valueFormatter={(value) => `${Math.round(value)}%`}
        unknownLabel="—"
        summary={statement.text}
        showAxis={false}
        showLegend={false}
        showReadout={false}
      />
      <Text
        style={[styles.quiet, text.detail, statement.tone === 'warning' ? styles.danger : null]}
        numberOfLines={1}
      >
        {statement.text}
      </Text>
    </HappierPressable>
  );
}

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
    <View testID={props.testID} style={styles.cycle} accessibilityLabel={`${ended}, ${detail}`}>
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
    ? <ChartDatum testID={`${props.testID}.detail`} datum={{ label: ended, value: exact, subtitle: detail }}>{visual}</ChartDatum> : visual;
}

function ProjectionRow(
  props: Readonly<{
    name: UsagePlanAccountName;
    window: UsagePlanWindow;
    nowMs: number;
    stacked: boolean;
    /** The list says the missing projection once; this row then shows its reset countdown. */
    resetOnly?: boolean;
    testID: string;
  }>,
) {
  const { window } = props;
  const statement = planWindowStatement(window, props.nowMs);
  const visual = (
    <UsageMeterRow
      testID={props.testID}
      label={`${props.name.title} · ${window.label}`}
      remainingPct={
        window.remainingFraction === null
          ? null
          : window.remainingFraction * 100
      }
      resetsAt={window.resetAtMs}
      tone={window.tone}
      now={props.nowMs}
      estimated={window.estimated}
      size={props.stacked ? 'default' : 'wide'}
      layout={props.stacked ? 'stacked' : 'inline'}
      {...(props.resetOnly ? {} : { resetText: statement.text })}
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
  const exact = window.remainingFraction === null ? null : formatHappierDataExactShare(window.remainingFraction, getPreferredLanguage());
  return exact === null || !window.pace && formatPlanPercent(window.remainingFraction!).includes(exact) ? visual
    : <ChartDatum testID={`${props.testID}.datum`} datum={{ label: `${props.name.title} · ${window.label}`,
      value: t('usage.board.plans.cellLeft', { percent: exact }),
      subtitle: [window.pace ? t('usage.board.plans.estimatedFrom', { count: window.pace.sampleCount }) : null,
        window.pace ? `${t('usage.board.plans.projectionUsedAtReset')} · ${formatHappierDataExactShare(window.pace.projectedUsedFraction, getPreferredLanguage())}` : null,
        window.resetAtMs === null ? null : formatPlanMoment(window.resetAtMs, props.nowMs)].filter(Boolean).join(' · ') }}>{visual}</ChartDatum>;
}

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
  quiet: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  danger: { color: theme.colors.state.danger.foreground },
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
