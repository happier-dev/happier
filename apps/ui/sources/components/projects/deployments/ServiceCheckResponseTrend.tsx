import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  StackedSeriesChart,
  type HappierSeries,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { vitalsAreaWash } from '@/components/machines/vitals/vitalsFormat';

import type { ServiceCheckListFacts } from './serviceCheckPresentation';
import { serviceCheckCollectorLatency, useServiceCheckCollectorTrend } from './useServiceCheckCollectorTrend';

/** The list column's line keeps the incumbent row sparkline width (processes CPU column). */
const LIST_LINE_WIDTH_PX = 84;

/**
 * A check's response over the last 24 h (D36 2A list line, 2B card area), on the shared series chart: its retained
 * results, or for a Key flow the collector's selected history (D33, R2-B), never its retained check timings. Ink unless
 * the check itself is failing or degraded: colour only for a failing saved check.
 */
export const ServiceCheckResponseTrend = React.memo(
  function ServiceCheckResponseTrend(
    props: Readonly<{
      facts: ServiceCheckListFacts;
      scope: Readonly<{ serverId: string; accountId: string }>;
      label: string;
      form: 'line' | 'area';
      width?: number;
    }>,
  ) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    const collector = useServiceCheckCollectorTrend(props.scope, props.facts.collectorTrend);
    const points = React.useMemo((): readonly Readonly<{ id: string; x: number; y: number | null }>[] => {
      const trend = props.facts.collectorTrend;
      if (!trend) return props.facts.response24h.map((point) => ({ id: String(point.observedAt), x: point.observedAt, y: point.latencyMs }));
      return collector.kind === 'ready' ? collector.read.trend.map((interval) => ({ id: JSON.stringify([interval.since, interval.until]),
        x: interval.until, y: serviceCheckCollectorLatency(trend.config, interval) })) : [];
    }, [collector, props.facts.collectorTrend, props.facts.response24h]);
    const color =
      props.facts.status === 'down'
        ? theme.colors.state.danger.textForeground
        : props.facts.status === 'degraded'
          ? theme.colors.state.warning.textForeground
          : theme.colors.text.secondary;
    const series = React.useMemo((): readonly HappierSeries[] | null => {
      // A gap (a result without a response time) draws nothing; two measured responses make a line.
      if (points.filter((point) => point.y !== null).length < 2) return null;
      return [
        {
          id: 'response',
          label: props.label,
          color,
          ...(props.form === 'area' ? { fillOpacity: vitalsAreaWash(theme.dark) } : {}),
          points,
        },
      ];
    }, [color, points, props.form, props.label, theme.dark]);
    if (!series) return null;
    return (
      <StackedSeriesChart
        theme={pluginTheme}
        label={props.label}
        series={series}
        variant={props.form}
        // The card's area takes the data family's tile plot without axes; the list line stays inline.
        size={props.form === 'area' ? 'tile' : 'inline'}
        // A picture beside its figure: the value is the latest response text next to it, never a second control in a row.
        decorative
        showAxis={false}
        showGrid={false}
        showScaleValues={false}
        fitLine
        {...(props.form === 'line' ? { width: props.width ?? LIST_LINE_WIDTH_PX } : {})}
      />
    );
  },
);
