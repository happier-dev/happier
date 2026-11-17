/**
 * **Slowest routes** (D36 Add widget → Telemetry): an Environment's routes over the last 24 hours,
 * slowest first, with their error rates. Ordering says which is slowest; the numbers stay ink.
 */

import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  DataRows,
  PaneHeaderContent,
  Stack,
  defineUiSurface,
  usePluginTranslation,
  useSurfaceContext,
  useWidgetPresentation,
  widgetFootprintBodyRows,
} from '@happier-dev/plugin-ui';
import type {
  DatabaseCaptureEndpointCursorV1,
  DatabaseCaptureEndpointV1,
} from '@happier-dev/database-protocol';

import {
  TELEMETRY_WIDGET_RANGE_MS,
  formatTelemetryMetric,
  readEndpointMeanMs,
  readTelemetryWidgetInputs,
} from './telemetryWidgetModel.js';
import {
  TelemetryWidgetQuiet,
  useTelemetryWidgetRead,
} from './useTelemetryWidgetRead.js';
import {
  TelemetryWidgetStale,
  TelemetryWidgetState,
} from './telemetryWidgetParts.js';

const TEST_ID = 'telemetry.slowest-routes';
/** Routes per collector page while ranking the whole window. */
const PAGE_LIMIT = 100;

type RankedRoute = Readonly<{
  key: string;
  route: string;
  meanMs: number | null;
  errorRate: number | null;
}>;

/** Every route the window saw, slowest mean first; a route with no timed request sorts last. */
export function rankSlowestRoutes(
  endpoints: readonly DatabaseCaptureEndpointV1[],
): readonly RankedRoute[] {
  return endpoints
    .map((endpoint) => ({
      key: `${endpoint.serviceName} ${endpoint.method} ${endpoint.route}`,
      route: `${endpoint.method} ${endpoint.route}`,
      meanMs: readEndpointMeanMs(endpoint),
      errorRate: endpoint.errorRate,
    }))
    .sort((left, right) => (right.meanMs ?? -1) - (left.meanMs ?? -1));
}

export function TelemetrySlowestRoutesWidget(
  props: Readonly<{ launchInput: unknown }>,
): React.ReactElement {
  const text = usePluginTranslation();
  const locale = useSurfaceContext().locale;
  const footprint = useWidgetPresentation()?.footprint;
  const launchKey = JSON.stringify(props.launchInput ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputs = React.useMemo(
    () => readTelemetryWidgetInputs(props.launchInput),
    [launchKey],
  );
  const { state, caption, retry } = useTelemetryWidgetRead({
    environment: inputs.environment,
    windowMs: TELEMETRY_WIDGET_RANGE_MS['24h'],
    readKey: 'routes',
    read: async (reader) => {
      const endpoints: DatabaseCaptureEndpointV1[] = [];
      let before: DatabaseCaptureEndpointCursorV1 | undefined;
      // Ranking needs every route in the window; the collector pages them in its own order.
      do {
        const page = await reader.endpoints(PAGE_LIMIT, before);
        endpoints.push(...page.items);
        before = page.nextCursor ?? undefined;
      } while (before !== undefined);
      if (endpoints.length === 0) throw new TelemetryWidgetQuiet();
      return rankSlowestRoutes(endpoints);
    },
  });
  // A glance shows the whole rows its card has room for, never one cut at the foot.
  const shownRows = footprint
    ? Math.max(1, widgetFootprintBodyRows(footprint))
    : 5;
  const rows = React.useMemo(
    () =>
      state.kind !== 'ready'
        ? []
        : state.data
            .slice(0, shownRows)
            .map((route) => [
              route.route,
              formatTelemetryMetric('p95', route.meanMs, locale),
              formatTelemetryMetric('errorRate', route.errorRate, locale),
            ]),
    [locale, shownRows, state],
  );
  return (
    <Stack testID={TEST_ID} gap="small" grow>
      <PaneHeaderContent
        {...(caption === null ? {} : { caption })}
        line={[text('plugins.telemetry.widgets.last24h', 'last 24 h')]}
      />
      {state.kind !== 'ready' ? (
        <TelemetryWidgetState state={state} retry={retry} testID={TEST_ID} />
      ) : (
        <>
          <TelemetryWidgetStale state={state} retry={retry} testID={TEST_ID} />
          <DataRows
            testID={`${TEST_ID}.rows`}
            label={text(
              'plugins.telemetry.widgets.slowestRoutes',
              'Slowest routes',
            )}
            columns={[
              {
                label: text('plugins.telemetry.widgets.route', 'Route'),
                priority: 'primary',
              },
              {
                label: text('plugins.telemetry.widgets.meanTime', 'Mean time'),
              },
              {
                label: text('plugins.telemetry.widgets.errors', 'Errors'),
                priority: 'secondary',
              },
            ]}
            rows={rows}
          />
        </>
      )}
    </Stack>
  );
}

export const renderSurface: RenderSurface = defineUiSurface((context) => (
  <TelemetrySlowestRoutesWidget launchInput={context.launchInput} />
));
