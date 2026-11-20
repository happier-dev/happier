import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CompositionStrip,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { MachinePressureIndicator } from '@/components/machines/summary/MachinePressureIndicator';
import { formatMachineMemoryPressureSource, resolveMachineResourceToneColor } from '@/components/machines/summary/machineSummaryStripModel';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import {
  usageSignatureAccent,
  withUsageAccentAlpha,
} from '@/components/settings/usage/usageAccent';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import {
  formatMachineBytes,
  formatMachinePartOfWhole,
  machineBytesParts,
  resolveMemoryTone,
  resolveMemoryZoom,
  selectMemoryReason,
  type MachineVitalsTimeline,
} from './machineVitalsPresentation';
import {
  VitalsHistoryChart,
  type VitalsChartFreshness,
} from './VitalsHistoryChart';
import { VitalsMeterRow } from './VitalsMeterRow';
import {
  VitalsMeta,
  VitalsEmphasis,
  VitalsSubLine,
  VitalsTile,
  VitalsTileSecondary,
  VitalsValue,
  useVitalsHeld,
} from './VitalsSheet';
import {
  formatVitalsPercent,
  vitalsAreaWash,
  vitalsPercentScale,
} from './vitalsFormat';

type ReportedMemory = Extract<
  MachineVitalsSampleV1['memory'],
  { reported: true }
>;

const COMPOSITION_KEYS = {
  apps: 'machineVitals.memory.composition.apps',
  wired: 'machineVitals.memory.composition.wired',
  compressed: 'machineVitals.memory.composition.compressed',
  kernel: 'machineVitals.memory.composition.kernel',
  system: 'machineVitals.memory.composition.system',
  cached_files: 'machineVitals.memory.composition.cachedFiles',
} as const;
/** Composition reads as ink steps, the heaviest first (lab: apps darkest, cached files lightest). */
export const COMPOSITION_INK = [0.62, 0.42, 0.28, 0.18] as const;

/**
 * Memory (lab `rv` O / OX, R10): pressure is the signal. Calm, the tile leads with what is free and the
 * pressure indicator sits small beside the label; when the machine needs a look the toned word takes the
 * value's place with how long it has held. Its history is in use: zoomed with a labelled floor while
 * calm, on a fixed 0–100 % scale when pressure is up, where the minutes the machine was under pressure
 * take its tone. Composition and swap follow; swap takes the tone only while the machine is swapping.
 * Where the OS reports no pressure (Windows) the tile says what it can — memory in use — and why.
 */
export const MemoryTile = React.memo(function MemoryTile(
  props: Readonly<{
    sample: MachineVitalsSampleV1;
    attention: MachineResourceAttentionV1 | null;
    timeline: MachineVitalsTimeline | null;
    axis: readonly [string, string];
    freshness: VitalsChartFreshness;
    live: boolean;
    nowMs: number;
    /** A Metric widget's "Warn above": percent of memory in use. */
    warnAbovePct?: number;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const memory = props.sample.memory.reported ? props.sample.memory : null;
  const reason = selectMemoryReason(props.attention);
  const tone = resolveMemoryTone(props.attention);
  const noPressure = memory?.pressure.level === 'not_reported';
  // Pressure is a running machine's present; held figures keep only what it had free (VitalsSheet `held`).
  const held = useVitalsHeld();
  const pressured = reason !== null && !held;
  const accent = usageSignatureAccent(theme);
  const levelInk = React.useCallback(
    (level: string) =>
      level === 'critical'
        ? resolveMachineResourceToneColor('crit', theme.colors)
        : level === 'elevated'
          ? resolveMachineResourceToneColor('warn', theme.colors)
          : undefined,
    [theme.colors],
  );
  const memoryTotalBytes = memory?.totalBytes ?? null;
  const chart = React.useMemo(() => {
    if (!props.timeline || memoryTotalBytes === null) return null;
    const total = memoryTotalBytes;
    if (pressured) {
      // On a fixed scale, the minutes spent under pressure take the machine's tone.
      const series: readonly HappierSeries[] = [
        {
          id: 'memory',
          label: t('machineVitals.history.mean'),
          color: accent,
          fillOpacity: vitalsAreaWash(theme.dark),
          points: props.timeline.points.map((point) => {
            const ink = levelInk(point.level);
            return {
              id: String(point.t),
              x: point.t,
              y:
                point.usedBytes === null || total <= 0
                  ? null
                  : Math.min(100, (point.usedBytes / total) * 100),
              ...(ink ? { color: ink } : {}),
            };
          }),
        },
        {
          id: 'memory-maximum', label: t('machineVitals.history.maximum'),
          color: withUsageAccentAlpha(accent, 0.55), overlay: true,
          points: props.timeline.points.map((point) => ({ id: String(point.t), x: point.t,
            y: point.usedBytesMax === null || total <= 0 ? null : Math.min(100, point.usedBytesMax / total * 100) })),
        },
      ];
      return {
        series,
        variant: 'area' as const,
        domain: vitalsPercentScale.domain,
        ticks: vitalsPercentScale.ticks,
        format: (value: number) => `${formatVitalsPercent(value)}%`,
        thresholdValue: props.warnAbovePct ?? null,
      };
    }
    const values = props.timeline.points.flatMap((point) =>
      point.usedBytes === null ? [] : [point.usedBytes, ...(point.usedBytesMax === null ? [] : [point.usedBytesMax])],
    );
    const zoom = resolveMemoryZoom(values, total);
    if (!zoom) return null;
    const series: readonly HappierSeries[] = [
      {
        id: 'memory',
        label: t('machineVitals.history.mean'),
        color: accent,
        fillOpacity: vitalsAreaWash(theme.dark),
        points: props.timeline.points.map((point) => ({
          id: String(point.t),
          x: point.t,
          y: point.usedBytes,
        })),
      },
      {
        id: 'memory-maximum', label: t('machineVitals.history.maximum'),
        color: withUsageAccentAlpha(accent, 0.55), overlay: true,
        points: props.timeline.points.map((point) => ({ id: String(point.t), x: point.t,
          y: point.usedBytesMax })),
      },
    ];
    return {
      series,
      variant: 'area' as const,
      domain: { min: zoom.min, max: zoom.max },
      ticks: zoom.ticks.map((value) => ({ value, label: formatMachineBytes(value, 'memory') })),
      format: (value: number) => formatMachineBytes(value, 'memory'),
      // The same percent, in the chart's own unit (bytes in use) on the zoomed scale.
      thresholdValue: props.warnAbovePct === undefined || total <= 0 ? null : (props.warnAbovePct / 100) * total,
    };
  }, [language, accent, levelInk, memoryTotalBytes, pressured, props.timeline, props.warnAbovePct, theme.dark]);
  const thresholdValue = chart?.thresholdValue ?? null;
  const warnAbovePct = props.warnAbovePct;
  const threshold = React.useMemo(() => thresholdValue === null || warnAbovePct === undefined ? undefined : {
    value: thresholdValue,
    tone: 'warning' as const,
    label: t('machines.widgets.body.metric.warnAbove', { value: `${formatVitalsPercent(warnAbovePct)}%` }),
  }, [language, thresholdValue, warnAbovePct]);

  if (!memory) {
    return (
      <VitalsTile
        testID="machine-vitals-memory"
        label={t('machineVitals.memory.title')}
        value={
          <VitalsValue
            value={t('machineVitals.unmeasured')}
            color={theme.colors.text.tertiary}
          />
        }
        sub={<VitalsSubLine>{t('machineVitals.notReported')}</VitalsSubLine>}
      />
    );
  }
  const free = machineBytesParts(memory.availableBytes, 'memory');
  const sourceLabel = formatMachineMemoryPressureSource(memory.pressure.source);
  const since = reason ? formatHeld(props.nowMs - reason.since) : null;
  const value = pressured ? (
    <MachinePressureIndicator
      testID="machine-vitals-pressure"
      level={reason.pressure}
      tone={tone}
      size="large"
      source={sourceLabel}
      detail={since}
    />
  ) : noPressure ? (
    <VitalsValue
      value={formatVitalsPercent(
        memory.totalBytes > 0
          ? (memory.usedBytes / memory.totalBytes) * 100
          : 0,
      )}
      unit="%"
      phrase={t('machineVitals.memory.inUseWord')}
    />
  ) : (
    <VitalsValue
      value={free.value}
      unit={free.unit}
      phrase={t('machineVitals.memory.freeWord')}
    />
  );
  const freeOfTotal = formatMachinePartOfWhole(
    memory.availableBytes,
    memory.totalBytes,
    'memory',
    'part',
  );
  const freeFigure = formatMachineBytes(memory.availableBytes, 'memory');
  const sub = pressured ? (
    <VitalsSubLine testID="machine-vitals-memory-sub">
      <VitalsEmphasis
        text={t('machineVitals.memory.freeAndInUse', { free: freeFigure, used: formatMachineBytes(memory.usedBytes, 'memory') })}
        emphasis={freeFigure}
      />
    </VitalsSubLine>
  ) : noPressure ? (
    <VitalsSubLine>
      <VitalsEmphasis
        text={t('machineVitals.memory.freeOfTotal', { free: freeOfTotal.part, total: freeOfTotal.whole })}
        emphasis={freeOfTotal.part}
      />
    </VitalsSubLine>
  ) : (
    <VitalsSubLine>
      {t('machineVitals.memory.inUseAmount', {
        used: formatMachineBytes(memory.usedBytes, 'memory'),
      })}
    </VitalsSubLine>
  );
  return (
    <VitalsTile
      testID="machine-vitals-memory"
      label={t('machineVitals.memory.title')}
      labelAccessory={
        !held &&
        !pressured &&
        !noPressure &&
        memory.pressure.level !== 'not_reported' ? (
          <MachinePressureIndicator
            level="calm"
            tone="calm"
            size="small"
            source={sourceLabel}
          />
        ) : null
      }
      meta={
        <VitalsMeta>
          {formatMachineBytes(memory.totalBytes, 'memory')}
        </VitalsMeta>
      }
      value={value}
      sub={sub}
    >
      {chart && props.timeline ? (
        <VitalsHistoryChart
          testID="machine-vitals-memory-chart"
          label={t('machineVitals.memory.chartLabel')}
          timeline={props.timeline}
          series={chart.series}
          variant={chart.variant}
          domain={chart.domain}
          scaleTicks={chart.ticks}
          axis={props.axis}
          format={chart.format}
          freshness={props.freshness}
          live={props.live}
          {...(threshold ? { threshold } : {})}
        />
      ) : null}
      <VitalsTileSecondary>
        <MemoryComposition memory={memory} />
      </VitalsTileSecondary>
      <VitalsTileSecondary tier="tertiary">
      {memory.swap ? (
        <SwapMeter
          swap={memory.swap}
          tone={
            memory.swap.swapping ? (tone === 'calm' ? 'warn' : tone) : 'calm'
          }
        />
      ) : null}
      </VitalsTileSecondary>
      {noPressure ? (
        <Text style={styles.note}>
          {t('machineVitals.memory.noPressureNote')}
        </Text>
      ) : null}
    </VitalsTile>
  );
});

function MemoryComposition(props: Readonly<{ memory: ReportedMemory }>) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const parts = props.memory.composition;
  const segments = React.useMemo(
    () =>
      (parts ?? [])
        .filter((part) => part.bytes > 0)
        .map((part, index) => ({
          id: part.kind,
          label: t(COMPOSITION_KEYS[part.kind]),
          value: part.bytes,
          color: withUsageAccentAlpha(
            theme.colors.text.primary,
            COMPOSITION_INK[Math.min(index, COMPOSITION_INK.length - 1)]!,
          ),
        })),
    [language, parts, theme.colors.text.primary],
  );
  if (segments.length === 0) return null;
  return (
    <CompositionStrip
      theme={pluginTheme}
      label={t('machineVitals.memory.compositionLabel')}
      total={props.memory.totalBytes}
      segments={segments}
      size="tile"
      segmentGap={2}
      valueFormatter={(value) => formatMachineBytes(value, 'memory')}
      appearance={{ legend: 'compact', height: 6 }}
      testID="machine-vitals-memory-composition"
    />
  );
}

function SwapMeter(
  props: Readonly<{
    swap: NonNullable<ReportedMemory['swap']>;
    tone: 'calm' | 'warn' | 'crit';
  }>,
) {
  const figure = formatMachinePartOfWhole(
    props.swap.usedBytes,
    props.swap.totalBytes,
    'memory',
    'whole',
  );
  const label =
    props.swap.kind === 'page_file'
      ? t('machineVitals.memory.pageFile')
      : t('machineVitals.memory.swap');
  return (
    <VitalsMeterRow
      testID="machine-vitals-swap"
      label={label}
      part={figure.part}
      whole={t('machineVitals.ofTotal', { total: figure.whole })}
      used={props.swap.usedBytes}
      capacity={props.swap.totalBytes}
      tone={props.tone}
      accessibilityLabel={t(
        props.swap.swapping
          ? 'machineVitals.memory.swapSwappingLabel'
          : 'machineVitals.memory.swapLabel',
        {
          name: label,
          used: formatMachineBytes(props.swap.usedBytes, 'memory'),
          total: formatMachineBytes(props.swap.totalBytes, 'memory'),
        },
      )}
    />
  );
}

/** "for 6 min", "for 2 h 10 min": how long a reason has held, from its own start. */
function formatHeld(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t('machineVitals.memory.heldMinutes', { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? t('machineVitals.memory.heldHours', { hours })
    : t('machineVitals.memory.heldHoursMinutes', { hours, minutes: rest });
}

const styles = StyleSheet.create((theme) => ({
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
