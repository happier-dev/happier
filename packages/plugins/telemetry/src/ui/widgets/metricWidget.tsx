/**
 * **Metric** (D36 Add widget → Telemetry): one app metric over a window — its number, then its line
 * filling the card, drawn by the same chart owner as the Machine metric widget.
 */

import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  HappierDataMetric,
  PaneHeaderContent,
  Stack,
  defineUiSurface,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import {
  TELEMETRY_WIDGET_RANGE_MS,
  formatTelemetryMetric,
  intervalMetricValue,
  readMetricValue,
  readTelemetryWidgetInputs,
  readTelemetryWidgetSeries,
  type TelemetryWidgetMetricV1,
  type TelemetryWidgetRangeV1,
} from './telemetryWidgetModel.js';
import {
  TelemetryWidgetQuiet,
  useTelemetryWidgetRead,
} from './useTelemetryWidgetRead.js';
import {
  TelemetryWidgetLine,
  TelemetryWidgetStale,
  TelemetryWidgetState,
} from './telemetryWidgetParts.js';

const TEST_ID = 'telemetry.metric';
const LINE_HEIGHT = 44;

type Translate = ReturnType<typeof usePluginTranslation>;

/** The metric's own name, as the setup's Metric field lists it. */
export function telemetryMetricLabel(
  metric: TelemetryWidgetMetricV1,
  text: Translate,
): string {
  switch (metric) {
    case 'p95':
      return text('plugins.telemetry.widgets.metric.p95', 'p95 request time');
    case 'p50':
      return text(
        'plugins.telemetry.widgets.metric.p50',
        'Median request time',
      );
    case 'errorRate':
      return text('plugins.telemetry.widgets.metric.errorRate', 'Error rate');
    case 'requests':
      return text('plugins.telemetry.widgets.metric.requests', 'Requests');
    case 'heap':
      return text('plugins.telemetry.widgets.metric.heap', 'Heap used');
  }
}

function rangeLabel(range: TelemetryWidgetRangeV1, text: Translate): string {
  return range === '7d'
    ? text('plugins.telemetry.widgets.last7d', 'last 7 days')
    : text('plugins.telemetry.widgets.last24h', 'last 24 h');
}

export function TelemetryMetricWidget(
  props: Readonly<{ launchInput: unknown }>,
): React.ReactElement {
  const text = usePluginTranslation();
  const theme = usePluginTheme();
  const locale = useSurfaceContext().locale;
  const launchKey = JSON.stringify(props.launchInput ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputs = React.useMemo(
    () => readTelemetryWidgetInputs(props.launchInput),
    [launchKey],
  );
  const { metric, range } = inputs;
  const { state, caption, retry } = useTelemetryWidgetRead({
    environment: inputs.environment,
    windowMs: TELEMETRY_WIDGET_RANGE_MS[range],
    readKey: metric,
    read: async (reader) => {
      const service = (await reader.endpoints(1)).items[0]?.serviceName;
      if (!service) throw new TelemetryWidgetQuiet();
      return await reader.metrics(service, metric);
    },
  });
  const label = telemetryMetricLabel(metric, text);
  const shown = React.useMemo(
    () =>
      state.kind !== 'ready'
        ? null
        : {
            value: readMetricValue(metric, state.data),
            series: readTelemetryWidgetSeries(
              state.data,
              metric,
              intervalMetricValue(metric),
            ),
          },
    [metric, state],
  );
  return (
    <Stack testID={TEST_ID} gap="small" grow>
      {/* The frame is titled by the metric it shows ("p95 request time"), not "Metric". */}
      <PaneHeaderContent
        title={label}
        {...(caption === null ? {} : { caption })}
        line={[rangeLabel(range, text)]}
      />
      {state.kind !== 'ready' || shown === null ? (
        state.kind === 'ready' ? null : (
          <TelemetryWidgetState state={state} retry={retry} testID={TEST_ID} />
        )
      ) : (
        <>
          <TelemetryWidgetStale state={state} retry={retry} testID={TEST_ID} />
          <HappierDataMetric
            theme={theme}
            size="stat"
            label={label}
            testID={`${TEST_ID}.value`}
            value={formatTelemetryMetric(metric, shown.value, locale)}
          />
          <Stack grow justify="flex-end" gap="none">
            <TelemetryWidgetLine
              series={shown.series}
              variant="area"
              height={LINE_HEIGHT}
              testID={`${TEST_ID}.line`}
            />
          </Stack>
        </>
      )}
    </Stack>
  );
}

export const renderSurface: RenderSurface = defineUiSurface((context) => (
  <TelemetryMetricWidget launchInput={context.launchInput} />
));
