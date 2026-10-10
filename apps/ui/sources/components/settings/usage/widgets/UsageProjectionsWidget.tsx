import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  BurnUpChart,
  formatHappierDataValue,
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierDataMetric,
  HappierPressable,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import {
  UsageMeterRow,
  UsageMeterStack,
} from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usageSignatureAccent } from '../usageAccent';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
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
  UsagePlansNothingRead,
  usePlanText,
} from './plans/UsagePlanParts';
import { readUsagePersonalPaceTarget, selectUsageWindowsAboveTarget } from './plans/usagePacingTarget';

/** Below this width a meter stacks its name over the bar and the projection beneath it. */
const STACKED_BELOW_PX = 460;

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
  const toReset = (id: string, label: string, fraction: number, color: string, lineStyle: 'dashed' | 'dotted'): HappierSeries => ({
    id, label, color, lineStyle, points: [{ ...last }, point(resetAtMs, fraction * 100)],
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
      label: t('usage.board.plans.earlierCurve', { time: ended }),
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
  const { projection, nameOf, nowMs } = useUsagePlans(props.slice, props.model);
  useWidgetFrameBodyCaption(t('usage.board.plans.projectionsCaption'));
  const paced = React.useMemo(() => selectUsagePacedWindows(projection.accounts), [projection.accounts]);
  // The viewer's pick, kept by window identity; a window that stops having a pace falls back to the default.
  const [pickedKey, setPickedKey] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const focus = React.useMemo(
    () => paced.find((entry) => entry.window.key === pickedKey) ?? pickDefaultFocus(paced, projection.tightest),
    [paced, pickedKey, projection.tightest],
  );
  const accent = usageSignatureAccent(theme);
  const rangeColor = theme.colors.text.tertiary;
  const ghostColor = theme.colors.border.default;
  const earlier = React.useMemo(
    () => (focus ? projectUsageEarlierCurves(focus.account, focus.window.meterId) : null),
    [focus],
  );
  const series = React.useMemo(
    () =>
      focus
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
    [focus, nowMs, accent, rangeColor, earlier, tile, ghostColor],
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
  if (projection.accounts.length === 0) {
    return (
      <View style={styles.body}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          slice={props.slice}
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
  const rows = projection.accounts.flatMap((account) =>
    account.windows
      .filter((window) => window.comparable || window.remainingFraction === null)
      .map((window) => ({ account, window, name: nameOf(account) })),
  );
  const focusName = focus ? nameOf(focus.account) : null;
  const focusTitle = focus && focusName ? `${focusName.title} · ${focus.window.label}` : '';
  const pace = focus?.window.pace ?? null;
  const depleting = rows.find((row) => row.window.pace?.depletesAtMs != null);
  const range = pace?.empiricalRange
    ? t('usage.board.plans.rangeAtReset', {
        min: formatPlanPercent(pace.empiricalRange.min),
        max: formatPlanPercent(pace.empiricalRange.max),
        count: pace.sampleCount,
      })
    : null;
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
              onSelect={(id) => {
                setPickerOpen(false);
                setPickedKey(id);
              }}
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
            testID={`${props.testID}.burnUp`}
            theme={chartTheme}
            size={tile ? 'tile' : 'full'}
            {...(tile ? {} : { viewportHeight: stacked ? 120 : 150 })}
            label={focusTitle}
            series={series}
            minimumMaximum={100}
            reference={{ value: 100, label: t('usage.board.plans.burnLimit') }}
            valueFormatter={(value) => `${Math.round(value)}%`}
            unknownLabel={t('common.unavailable')}
            valuesLabel={t('usage.showAll')}
            valuesCollapseLabel={t('usage.showLess')}
            summary={[planWindowStatement(focus.window, nowMs).text, range].filter(Boolean).join(' · ')}
            showAxis={!tile}
            showScaleValues={!tile}
            showLegend={!tile}
            {...(axisTicks ? { axisTicks } : {})}
            showReadout={false}
          />
          {range ? (
            <Text testID={`${props.testID}.range`} accessibilityLabel={range} style={[styles.quiet, text.detail]}>
              {range}
            </Text>
          ) : null}
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
          title={t('usage.board.plans.noPaceAnywhere')}
          reason={t('usage.board.plans.noPaceAnywhereReason')}
        />
      )}
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
              onPick={setPickedKey}
              testID={`${props.testID}.multiple.${entry.account.accountId}.${entry.window.meterId}`}
            />
          ))}
        </View>
      ) : null}
      {tile ? null : (
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
      {!tile && focus && focusName ? (
        <UsagePlanDisclosure
          testID={`${props.testID}.pastCycles`}
          title={t('usage.board.plans.pastCyclesTitle')}
          meta={focusTitle}
        >
          <PastCycles account={focus.account} window={focus.window} nowMs={nowMs} testID={`${props.testID}.pastCycles`} />
        </UsagePlanDisclosure>
      ) : null}
      {depleting ? (
        <View style={styles.paceNote} testID={`${props.testID}.ahead`}>
          <Icon name="warning" size={13} color={theme.colors.state.danger.foreground} />
          <Text style={[styles.paceNoteText, text.detail]}>
            {[
              `${depleting.name.title} · ${depleting.window.label}`,
              t('usage.board.plans.projectionRunsOut', {
                time: formatPlanMoment(depleting.window.pace!.depletesAtMs!, nowMs),
              }),
              t('usage.board.plans.projectionBeforeReset'),
            ].join(' · ')}
          </Text>
        </View>
      ) : null}
      {targetNote ? (
        <Text style={[styles.targetNote, text.detail]} testID={`${props.testID}.target`}>{targetNote}</Text>
      ) : null}
      {tile ? null : (
        <UsagePlanLegend
          parts={[
            t('usage.board.plans.legendEvenPace'),
            t('usage.board.plans.legendHatched'),
          ]}
        />
      )}
      <UsageCoverageLine
        slice={props.slice}
        sources={['quota']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
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
  return (
    <View style={styles.headline}>
      <HappierDataMetric
        testID={props.testID}
        theme={chartTheme}
        size="stat"
        label={runsOut ? t('usage.board.plans.projectionRunsOutLabel') : t('usage.board.plans.projectionUsedAtReset')}
        value={runsOut ? formatPlanMoment(pace.depletesAtMs!, props.nowMs) : Math.round(pace.projectedUsedFraction * 100)}
        {...(runsOut ? {} : { valueFormatter: (value: number) => `~${value}%` })}
        showLabel
        caption={basis}
      />
      {runsOut ? (
        <View style={styles.paceNote}>
          <Icon name="warning" size={13} color={theme.colors.state.danger.foreground} />
          <Text style={[styles.paceNoteText, text.detail]}>{t('usage.board.plans.projectionBeforeReset')}</Text>
        </View>
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
        unknownLabel={t('common.unavailable')}
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
  return (
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
}

function ProjectionRow(
  props: Readonly<{
    name: UsagePlanAccountName;
    window: UsagePlanWindow;
    nowMs: number;
    stacked: boolean;
    testID: string;
  }>,
) {
  const { window } = props;
  const statement = planWindowStatement(window, props.nowMs);
  return (
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
      resetText={statement.text}
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
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 16 },
  chart: { gap: 10 },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    maxWidth: '100%',
    borderRadius: theme.borderRadius.sm,
  },
  chartTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  headline: { gap: 4 },
  quiet: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  danger: { color: theme.colors.state.danger.foreground },
  multiples: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 14 },
  multiple: { flexGrow: 1, minWidth: 0, gap: 6, borderRadius: theme.borderRadius.sm },
  multipleTitle: { ...Typography.default('medium'), color: theme.colors.text.secondary },
  cycles: { gap: 10 },
  cycle: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cycleWhen: {
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
    width: 96,
  },
  cycleBody: { flex: 1, minWidth: 0, gap: 5 },
  paceNote: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  paceNoteText: {
    ...Typography.default('medium'),
    color: theme.colors.state.danger.foreground,
    flexShrink: 1,
  },
  targetNote: { ...Typography.default(), color: theme.colors.text.secondary },
}));
