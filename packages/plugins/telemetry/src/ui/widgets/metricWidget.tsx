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
  formatTelemetryRoute,
  intervalMetricValue,
  readComparedBeforeValue,
  readMetricValue,
  readTelemetryWidgetInputs,
  readTelemetryWidgetSeries,
  telemetryWidgetComparedMeasure,
  telemetryWidgetMeasure,
  type TelemetryWidgetMetricV1,
  type TelemetryWidgetRangeV1,
  type TelemetryWidgetRouteV1,
} from './telemetryWidgetModel.js';
import {
  TelemetryWidgetQuiet,
  useTelemetryWidgetRead,
  type TelemetryWidgetReader,
} from './useTelemetryWidgetRead.js';
import {
  TelemetryWidgetLine,
  TelemetryWidgetStale,
  TelemetryWidgetState,
} from './telemetryWidgetParts.js';

const TEST_ID = 'telemetry.metric';
/** The line's floor: a glance line at a card's smallest room. */
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

/** One page of routes per step while looking for the service that serves the chosen route. */
const ROUTE_PAGE_LIMIT = 100;

/**
 * The service the read is for: the one serving the chosen route, or the busiest one for the whole-service read.
 * Null when the collector saw none of it in the window.
 */
async function readMetricService(
  reader: TelemetryWidgetReader,
  route: TelemetryWidgetRouteV1 | null,
): Promise<string | null> {
  if (!route) return (await reader.endpoints(1)).items[0]?.serviceName ?? null;
  let before: Parameters<TelemetryWidgetReader['endpoints']>[1];
  do {
    const page = await reader.endpoints(ROUTE_PAGE_LIMIT, before);
    const served = page.items.find((item) => item.method === route.method && item.route === route.route);
    if (served) return served.serviceName;
    before = page.nextCursor ?? undefined;
  } while (before);
  return null;
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
  const { metric, range, route, show } = inputs;
  const { state, caption, retry } = useTelemetryWidgetRead({
    environment: inputs.environment,
    windowMs: TELEMETRY_WIDGET_RANGE_MS[range],
    readKey: JSON.stringify([metric, route]),
    read: async (reader) => {
      const service = await readMetricService(reader, route);
      if (!service) throw new TelemetryWidgetQuiet();
      const compared = telemetryWidgetComparedMeasure(metric, route);
      // The comparison is a fact under the number: when it cannot be read, the number still stands alone.
      const [read, before] = await Promise.all([
        reader.metrics(service, telemetryWidgetMeasure(metric, route)),
        compared === null
          ? Promise.resolve(null)
          : reader.compare(service, compared).then(readComparedBeforeValue, () => null),
      ]);
      return { read, before };
    },
  });
  const label = telemetryMetricLabel(metric, text);
  // The route leads the frame's source line ("POST /checkout · billing-api · Production").
  const sourceLine = route === null ? caption
    : caption === null ? formatTelemetryRoute(route) : `${formatTelemetryRoute(route)} · ${caption}`;
  // The room left under the figure, measured once laid out; never shorter than the glance line.
  const [lineHeight, setLineHeight] = React.useState(LINE_HEIGHT);
  const onLineRoomLayout = React.useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    const room = Math.max(LINE_HEIGHT, Math.floor(event.nativeEvent.layout.height));
    setLineHeight((previous) => (previous === room ? previous : room));
  }, []);
  const shown = React.useMemo(
    () =>
      state.kind !== 'ready'
        ? null
        : {
            value: readMetricValue(metric, state.data.read),
            series: readTelemetryWidgetSeries(
              state.data.read,
              metric,
              intervalMetricValue(metric),
            ),
            comparison:
              state.data.before === null
                ? null
                : text(
                    'plugins.telemetry.widgets.metric.beforeDeploy',
                    'was {value} before the last deploy',
                  ).replace('{value}', formatTelemetryMetric(metric, state.data.before, locale)),
          },
    [metric, state, text, locale],
  );
  return (
    <Stack testID={TEST_ID} gap="small" grow>
      {/* The frame is titled by the metric it shows ("p95 request time"), not "Metric". */}
      <PaneHeaderContent
        title={label}
        {...(sourceLine === null ? {} : { caption: sourceLine })}
        line={[rangeLabel(range, text)]}
      />
      {state.kind !== 'ready' || shown === null ? (
        state.kind === 'ready' ? null : (
          <TelemetryWidgetState state={state} retry={retry} testID={TEST_ID} />
        )
      ) : (
        <>
          <TelemetryWidgetStale state={state} retry={retry} testID={TEST_ID} />
          {show === 'chart' ? null : (
            <HappierDataMetric
              theme={theme}
              size="stat"
              label={label}
              testID={`${TEST_ID}.value`}
              value={formatTelemetryMetric(metric, shown.value, locale)}
              {...(shown.comparison === null ? {} : { caption: shown.comparison })}
            />
          )}
          {/* The line takes the room under the figure, as the Machine metric's chart fills its card (lab p7Surfaces home). */}
          {show === 'number' ? null : (
            <Stack grow justify="flex-end" gap="none" onLayout={onLineRoomLayout}>
              <TelemetryWidgetLine
                series={shown.series}
                variant="area"
                height={lineHeight}
                testID={`${TEST_ID}.line`}
              />
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

export const renderSurface: RenderSurface = defineUiSurface((context) => (
  <TelemetryMetricWidget launchInput={context.launchInput} />
));
