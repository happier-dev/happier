/**
 * **App vitals** (D36 Home 4A): an Environment's requests, p95 and error rate over the last 24 hours,
 * each a number with its line. One whole-service read serves all three: the collector's p95 read
 * carries request count and error rate per interval too.
 */

import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  PaneHeaderContent,
  Row,
  Stack,
  Text,
  defineUiSurface,
  usePluginTranslation,
  useSurfaceContext,
  type HappierSeries,
} from '@happier-dev/plugin-ui';
import type { TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';

import {
  TELEMETRY_WIDGET_RANGE_MS,
  formatTelemetryMetric,
  intervalErrorRate,
  intervalP95,
  intervalRequestRate,
  readErrorRate,
  readP95Ms,
  readRequestRate,
  readTelemetryWidgetInputs,
  readTelemetryWidgetSeries,
  telemetryWidgetMeasure,
  type TelemetryWidgetMetricV1,
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

const TEST_ID = 'telemetry.app-vitals';
const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 18;

type Vital = Readonly<{
  id: string;
  label: string;
  metric: TelemetryWidgetMetricV1;
  value: number | null;
  series: HappierSeries | null;
}>;

function readVitals(
  read: TelemetryMetricsReadResultV1,
  text: ReturnType<typeof usePluginTranslation>,
): readonly Vital[] {
  return [
    {
      id: 'requests',
      label: text('plugins.telemetry.widgets.requests', 'Requests'),
      metric: 'requests',
      value: readRequestRate(read),
      series: readTelemetryWidgetSeries(read, 'requests', intervalRequestRate),
    },
    {
      id: 'p95',
      label: text('plugins.telemetry.widgets.p95', 'p95'),
      metric: 'p95',
      value: readP95Ms(read),
      series: readTelemetryWidgetSeries(read, 'p95', intervalP95),
    },
    {
      id: 'errors',
      label: text('plugins.telemetry.widgets.errors', 'Errors'),
      metric: 'errorRate',
      value: readErrorRate(read),
      series: readTelemetryWidgetSeries(read, 'errors', intervalErrorRate),
    },
  ];
}

export function TelemetryAppVitalsWidget(
  props: Readonly<{ launchInput: unknown }>,
): React.ReactElement {
  const text = usePluginTranslation();
  const locale = useSurfaceContext().locale;
  const launchKey = JSON.stringify(props.launchInput ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputs = React.useMemo(
    () => readTelemetryWidgetInputs(props.launchInput),
    [launchKey],
  );
  const { state, caption, retry } = useTelemetryWidgetRead({
    environment: inputs.environment,
    windowMs: TELEMETRY_WIDGET_RANGE_MS['24h'],
    readKey: 'vitals',
    read: async (reader) => {
      // The Environment's service, as its app names itself to the collector.
      const service = (await reader.endpoints(1)).items[0]?.serviceName;
      if (!service) throw new TelemetryWidgetQuiet();
      return await reader.metrics(service, telemetryWidgetMeasure('p95'));
    },
  });
  const vitals = React.useMemo(
    () => (state.kind === 'ready' ? readVitals(state.data, text) : null),
    [state, text],
  );
  return (
    <Stack testID={TEST_ID} gap="small" grow>
      <PaneHeaderContent
        {...(caption === null ? {} : { caption })}
        line={[text('plugins.telemetry.widgets.last24h', 'last 24 h')]}
      />
      {state.kind !== 'ready' ? <TelemetryWidgetState state={state} retry={retry} testID={TEST_ID} /> : (
        <>
          <TelemetryWidgetStale state={state} retry={retry} testID={TEST_ID} />
          <Stack gap="small">
            {(vitals ?? []).map(vital => (
              <Row key={vital.id} testID={`${TEST_ID}.${vital.id}`} gap="medium" align="center">
                <Stack grow gap="none"><Text tone="secondary" value={vital.label} numberOfLines={1} /></Stack>
                <TelemetryWidgetLine series={vital.series} variant="line" width={SPARK_WIDTH} height={SPARK_HEIGHT} />
                <Text variant="label" emphasis="semiBold" testID={`${TEST_ID}.${vital.id}.value`}
                  value={formatTelemetryMetric(vital.metric, vital.value, locale)} />
              </Row>
            ))}
          </Stack>
        </>
      )}
    </Stack>
  );
}

export const renderSurface: RenderSurface = defineUiSurface((context) => (
  <TelemetryAppVitalsWidget launchInput={context.launchInput} />
));
