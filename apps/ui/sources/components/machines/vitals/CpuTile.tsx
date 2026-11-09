import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CoreLoadBars,
  HappierPressable,
  type CoreLoadBar,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';
import type {
  MachineVitalsHostFactsV1,
  MachineVitalsSampleV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageSignatureAccent, withUsageAccentAlpha } from '@/components/settings/usage/usageAccent';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import {
  resolveMachineCoreCount,
  selectMachineVitalsReading,
  type MachineVitalsTimeline,
} from './machineVitalsPresentation';
import {
  VitalsHistoryChart,
  type VitalsChartFreshness,
} from './VitalsHistoryChart';
import {
  VitalsMeta,
  VitalsSubLine,
  VitalsTile,
  VitalsTileSecondary,
  VitalsValue,
} from './VitalsSheet';
import {
  formatVitalsLoad,
  formatVitalsPercent,
  vitalsAreaWash,
  vitalsPercentScale, formatVitalsPointTime } from './vitalsFormat';

/**
 * CPU (lab `rv` O): busy percent of the whole machine, the cores it has, its hour on a fixed 0–100 %
 * scale (a 2 → 3 % wobble stays flat), and Per core opening in place with each core's load, the
 * user / system split and, where the OS gives them, I/O wait, steal and load averages.
 */
export const CpuTile = React.memo(function CpuTile(
  props: Readonly<{
    sample: MachineVitalsSampleV1;
    host: MachineVitalsHostFactsV1 | null;
    timeline: MachineVitalsTimeline | null;
    axis: readonly [string, string];
    freshness: VitalsChartFreshness;
    live: boolean;
    /** A Metric widget's "Warn above", percent of the whole machine. */
    warnAbovePct?: number;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const cpu = props.sample.cpu.reported ? props.sample.cpu : null;
  const reading = cpu ? selectMachineVitalsReading({ value: cpu.busyPct, sampledAt: props.sample.sampledAt,
    timeline: props.timeline, metric: 'cpu' }) : null;
  const accent = usageSignatureAccent(theme);
  const series = React.useMemo(
    (): readonly HappierSeries[] =>
      props.timeline
        ? [
            {
              id: 'cpu',
              label: t('machineVitals.history.mean'),
              color: accent,
              fillOpacity: vitalsAreaWash(theme.dark),
              points: props.timeline.points.map((point) => ({
                id: String(point.t),
                x: point.t,
                y: point.cpu,
              })),
            },
            {
              id: 'cpu-maximum', label: t('machineVitals.history.maximum'),
              color: withUsageAccentAlpha(accent, 0.55), overlay: true,
              points: props.timeline.points.map((point) => ({ id: String(point.t), x: point.t,
                y: point.cpuMax })),
            },
          ]
        : [],
    [language, accent, props.timeline, theme.dark],
  );
  const cores = props.host ? resolveMachineCoreCount(props.host) : null;
  const warnAbovePct = props.warnAbovePct;
  const threshold = React.useMemo(() => warnAbovePct === undefined ? undefined : {
    value: warnAbovePct,
    tone: 'warning' as const,
    label: t('machines.widgets.body.metric.warnAbove', { value: formatVitalsPercentLabel(warnAbovePct) }),
  }, [language, warnAbovePct]);
  const [open, setOpen] = React.useState(false);
  return (
    <VitalsTile
      testID="machine-vitals-cpu"
      label={t('machineVitals.cpu.title')}
      meta={
        // One freshness statement per page: a stale or offline answer is said once, by the tab row's chip; a card dates
        // itself only when it alone is behind the rest.
        reading?.held && props.freshness === 'live' ? (
          <VitalsMeta>{t('machineVitals.asOf', { time: formatVitalsPointTime(reading.sampledAt) })}</VitalsMeta>
        ) : cpu?.load1 !== undefined ? (
          <VitalsMeta>
            {t('machineVitals.cpu.load', { load: formatVitalsLoad(cpu.load1) })}
          </VitalsMeta>
        ) : null
      }
      value={
        reading ? (
          <VitalsValue value={formatVitalsPercent(reading.value)} unit="%" />
        ) : (
          <VitalsValue
            value={t('machineVitals.unmeasured')}
            color={theme.colors.text.tertiary}
          />
        )
      }
      sub={
        cpu?.throttled ? (
          <VitalsSubLine>
            {t('machineVitals.cpu.coresLimited', { count: cores ?? 0 })}
          </VitalsSubLine>
        ) : cores !== null ? (
          <VitalsSubLine>
            {t('machineVitals.cpu.cores', { count: cores })}
          </VitalsSubLine>
        ) : null
      }
    >
      {props.timeline ? (
        <VitalsHistoryChart
          testID="machine-vitals-cpu-chart"
          label={t('machineVitals.cpu.chartLabel')}
          timeline={props.timeline}
          series={series}
          variant="area"
          domain={vitalsPercentScale.domain}
          scaleTicks={vitalsPercentScale.ticks}
          axis={props.axis}
          format={formatVitalsPercentLabel}
          freshness={props.freshness}
          live={props.live}
          {...(threshold ? { threshold } : {})}
        />
      ) : null}
      {cpu ? (
        <VitalsTileSecondary>
        <ExpandableItem
          expanded={open}
          onExpandedChange={setOpen}
          showDivider={false}
          testID="machine-vitals-per-core"
          header={(state) => (
            <HappierPressable
              {...state.headerProps}
              accessibilityLabel={t('machineVitals.cpu.perCore')}
              style={styles.disclosure}
              testID="machine-vitals-per-core-toggle"
            >
              <DisclosureCaret expanded={state.expanded} />
              <Text style={styles.disclosureLabel}>
                {t('machineVitals.cpu.perCore')}
              </Text>
            </HappierPressable>
          )}
        >
          <PerCoreBody cpu={cpu} host={props.host} />
        </ExpandableItem>
        </VitalsTileSecondary>
      ) : null}
    </VitalsTile>
  );
});

type ReportedCpu = Extract<MachineVitalsSampleV1['cpu'], { reported: true }>;

function PerCoreBody(
  props: Readonly<{ cpu: ReportedCpu; host: MachineVitalsHostFactsV1 | null }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const { cpu, host } = props;
  const cores = React.useMemo(
    (): readonly CoreLoadBar[] =>
      (cpu.perCore ?? []).map((busyPct, index) => ({
        index,
        busyPct,
        ...(cpu.clusters?.[index] ? { cluster: cpu.clusters[index] } : {}),
      })),
    [cpu.clusters, cpu.perCore],
  );
  const legend =
    host?.performanceCores && host.efficiencyCores
      ? {
          p: t('machineVitals.cpu.performanceCores', {
            count: host.performanceCores,
          }),
          e: t('machineVitals.cpu.efficiencyCores', {
            count: host.efficiencyCores,
          }),
        }
      : undefined;
  const facts = [
    cpu.userPct !== undefined && cpu.userPct !== null
      ? t('machineVitals.cpu.user', {
          percent: formatVitalsPercent(cpu.userPct),
        })
      : null,
    cpu.systemPct !== undefined && cpu.systemPct !== null
      ? t('machineVitals.cpu.system', {
          percent: formatVitalsPercent(cpu.systemPct),
        })
      : null,
    cpu.iowaitPct !== undefined && cpu.iowaitPct !== null
      ? t('machineVitals.cpu.iowait', {
          percent: formatVitalsPercent(cpu.iowaitPct),
        })
      : null,
    cpu.stealPct !== undefined && cpu.stealPct !== null
      ? t('machineVitals.cpu.steal', {
          percent: formatVitalsPercent(cpu.stealPct),
        })
      : null,
    cpu.load1 !== undefined &&
    cpu.load5 !== undefined &&
    cpu.load15 !== undefined
      ? t('machineVitals.cpu.loadAverages', {
          one: formatVitalsLoad(cpu.load1),
          five: formatVitalsLoad(cpu.load5),
          fifteen: formatVitalsLoad(cpu.load15),
        })
      : null,
  ].filter((fact): fact is string => fact !== null);
  const topology =
    !legend && host
      ? [
          t('machineVitals.cpu.cores', {
            count: resolveMachineCoreCount(host),
          }),
          ...(host.sockets && host.sockets > 1
            ? [t('machineVitals.cpu.sockets', { count: host.sockets })]
            : []),
        ].join(' · ')
      : null;
  return (
    <View style={styles.perCore}>
      {cores.length > 0 ? (
        <CoreLoadBars
          theme={pluginTheme}
          label={t('machineVitals.cpu.perCoreLabel')}
          cores={cores}
          legend={legend}
          coreLabel={(core) =>
            t(
              core.cluster === 'p'
                ? 'machineVitals.cpu.coreLabelPerformance'
                : core.cluster === 'e'
                  ? 'machineVitals.cpu.coreLabelEfficiency'
                  : 'machineVitals.cpu.coreLabel',
              {
                index: core.index + 1,
                percent:
                  core.busyPct === null
                    ? t('machineVitals.unmeasured')
                    : `${formatVitalsPercent(core.busyPct)}%`,
              },
            )
          }
          testID="machine-vitals-cores"
        />
      ) : (
        <Text style={styles.fact}>
          {cpu.perCoreNotReportedReason === 'container'
            ? t('machineVitals.cpu.perCoreContainer')
            : t('machineVitals.cpu.perCoreUnavailable')}
        </Text>
      )}
      {topology ? <Text style={styles.fact}>{topology}</Text> : null}
      {facts.length > 0 ? (
        <Text style={styles.fact}>{facts.join(' · ')}</Text>
      ) : null}
    </View>
  );
}

function formatVitalsPercentLabel(value: number): string {
  return `${formatVitalsPercent(value)}%`;
}


const styles = StyleSheet.create((theme) => ({
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    alignSelf: 'flex-start',
    minHeight: 28,
    paddingRight: theme.space.s8,
  },
  disclosureLabel: {
    ...Typography.variant('meta'),
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  perCore: {
    gap: theme.space.s8,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s2,
  },
  fact: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
  },
}));
