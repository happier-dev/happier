import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';

import type { ServiceCheckListFacts } from './serviceCheckPresentation';
import { serviceCheckCollectorLatency, useServiceCheckCollectorTrend } from './useServiceCheckCollectorTrend';
import { ServiceTrendChart } from './ServiceTrendChart';

/**
 * A check's response over the last 24 h (D36 2A list line, 2B card area), on the shared series chart: its retained
 * results, or for a Key flow the collector's selected history (D33, R2-B), never its retained check timings. Always ink.
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
    const collector = useServiceCheckCollectorTrend(props.scope, props.facts.collectorTrend);
    const points = React.useMemo((): HappierSeries['points'] => {
      const trend = props.facts.collectorTrend;
      if (!trend) return props.facts.response24h.map((point) => ({ id: String(point.observedAt), x: point.observedAt, y: point.latencyMs }));
      return collector.kind === 'ready' ? collector.read.trend.map((interval) => ({ id: JSON.stringify([interval.since, interval.until]),
        x: interval.until, y: serviceCheckCollectorLatency(trend.config, interval) })) : [];
    }, [collector, props.facts.collectorTrend, props.facts.response24h]);
    // The response stays ink: a Key flow's history has its own window and its saved result carries the tone; a status
    // failure (a 502) is said by the State column and the cause, not by a normal latency (D8).
    const color = theme.colors.text.secondary;
    return (
      <ServiceTrendChart seriesId="response" label={props.label} color={color} points={points} form={props.form}
        {...(props.width === undefined ? {} : { width: props.width })} />
    );
  },
);
