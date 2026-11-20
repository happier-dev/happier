import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import {
  formatMachineBytes,
  resolveNetworkDomain,
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
  VitalsValue,
  useVitalsHeld,
} from './VitalsSheet';
import {
  formatVitalsPointTime,
  formatVitalsRate,
  formatVitalsRateParts,
  vitalsAreaWash,
} from './vitalsFormat';

/**
 * Network (lab `rv` O): download is the figure, upload the quiet fact at the right, the busiest interface
 * and today's totals under them, and the hour mirrored — down above the baseline, up below it in the same
 * units — on an auto-scaled round ceiling that is labelled. Hovering the figure lists each interface.
 */
export const NetworkTile = React.memo(function NetworkTile(
  props: Readonly<{
    sample: MachineVitalsSampleV1;
    today: MachineVitalsHistoryV1['today'] | null;
    timeline: MachineVitalsTimeline | null;
    axis: readonly [string, string];
    freshness: VitalsChartFreshness;
    live: boolean;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const network = props.sample.network.reported ? props.sample.network : null;
  const accent = usageSignatureAccent(theme);
  // A machine that isn't running moves nothing: its last rate would read as now, so it says none (its hour stays).
  const held = useVitalsHeld();
  const chart = React.useMemo(() => {
    if (!props.timeline) return null;
    const domain = resolveNetworkDomain(props.timeline.points);
    const series: readonly HappierSeries[] = [
      {
        id: 'down',
        label: t('machineVitals.network.down'),
        color: accent,
        fillOpacity: vitalsAreaWash(theme.dark),
        points: props.timeline.points.map((point) => ({
          id: String(point.t),
          x: point.t,
          y: point.rxBps,
        })),
      },
      {
        id: 'up',
        label: t('machineVitals.network.up'),
        color: theme.colors.text.tertiary,
        fillOpacity: vitalsAreaWash(theme.dark),
        points: props.timeline.points.map((point) => ({
          id: String(point.t),
          x: point.t,
          y: point.txBps === null ? null : -point.txBps,
        })),
      },
    ];
    const ceiling = formatVitalsRateParts(domain.ceiling);
    return {
      series,
      domain: { min: domain.min, max: domain.max },
      ticks: [
        { value: 0, label: '' },
        { value: domain.max, label: ceiling.value },
      ],
    };
  }, [language, accent, props.timeline, theme.colors.text.tertiary, theme.dark]);
  if (!network) {
    return (
      <VitalsTile
        testID="machine-vitals-network"
        label={t('machineVitals.network.title')}
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
  const downReading = selectMachineVitalsReading({ value: network.rxBps, sampledAt: props.sample.sampledAt,
    timeline: props.timeline, metric: 'rxBps' });
  const upReading = selectMachineVitalsReading({ value: network.txBps, sampledAt: props.sample.sampledAt,
    timeline: props.timeline, metric: 'txBps' });
  const down = downReading && !held ? formatVitalsRateParts(downReading.value) : null;
  const heldAt = Math.min(...[downReading, upReading].flatMap(reading => reading?.held ? [reading.sampledAt] : []));
  const interfaces = (network.interfaces ?? []).filter(
    (entry) => entry.included,
  );
  const perInterface = interfaces
    .map((entry) =>
      t('machineVitals.network.interfaceRate', {
        name: entry.label,
        down:
          entry.rxBps === null
            ? t('machineVitals.unmeasured')
            : formatVitalsRate(entry.rxBps),
        up:
          entry.txBps === null
            ? t('machineVitals.unmeasured')
            : formatVitalsRate(entry.txBps),
      }),
    )
    .join('\n');
  const sub = [
    Number.isFinite(heldAt) && props.freshness === 'live' ? t('machineVitals.asOf', { time: formatVitalsPointTime(heldAt) }) : null,
    network.label ?? null,
    props.today
      ? t('machineVitals.network.today', {
          down: formatMachineBytes(props.today.rxBytes, 'storage'),
          up: formatMachineBytes(props.today.txBytes, 'storage'),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const value = (
    <VitalsValue
      leading={held ? undefined : (
        <Icon
          name="arrow-down"
          size={ICON_SIZE.sm}
          color={theme.colors.text.tertiary}
          style={styles.arrow}
        />
      )}
      value={down ? down.value : t('machineVitals.unmeasured')}
      unit={
        down
          ? t('machineVitals.network.perSecondUnit', { unit: down.unit })
          : undefined
      }
    />
  );
  return (
    <VitalsTile
      testID="machine-vitals-network"
      label={t('machineVitals.network.title')}
      meta={
        upReading && !held ? (
          <VitalsMeta
            leading={
              <Icon
                name="arrow-up"
                size={ICON_SIZE.xs}
                color={theme.colors.text.tertiary}
              />
            }
          >
            {formatVitalsRate(upReading.value)}
          </VitalsMeta>
        ) : null
      }
      value={
        perInterface ? (
          <Tooltip label={perInterface} style={styles.valueTooltip}>
            {value}
          </Tooltip>
        ) : (
          value
        )
      }
      sub={sub ? <VitalsSubLine>{sub}</VitalsSubLine> : null}
    >
      {chart && props.timeline ? (
        <VitalsHistoryChart
          testID="machine-vitals-network-chart"
          label={t('machineVitals.network.chartLabel')}
          timeline={props.timeline}
          series={chart.series}
          variant="area"
          mirrored
          domain={chart.domain}
          scaleTicks={chart.ticks}
          axis={props.axis}
          format={formatNetworkChartRate}
          freshness={props.freshness}
          live={props.live}
        />
      ) : null}
    </VitalsTile>
  );
});

function formatNetworkChartRate(rate: number): string {
  return formatVitalsRate(Math.abs(rate));
}

const styles = StyleSheet.create(() => ({
  arrow: {
    alignSelf: 'center',
    marginRight: 2,
  },
  valueTooltip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
}));
