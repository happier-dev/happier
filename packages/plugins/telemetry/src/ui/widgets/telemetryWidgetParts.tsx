/**
 * The pieces the Telemetry widgets share: the read states every widget answers the same way, and
 * the inline line drawn by the shared chart owner (the same `StackedSeriesChart` the Machine vitals
 * and metric widgets draw), so an app's line reads exactly like a Machine's.
 */

import * as React from 'react';
import {
  EmptyState,
  ErrorState,
  FreshnessLine,
  LoadingState,
  StackedSeriesChart,
  Stack,
  usePluginTheme,
  usePluginTranslation,
  type HappierSeries,
} from '@happier-dev/plugin-ui';

import type { TelemetryWidgetReadState } from './useTelemetryWidgetRead.js';

/** A decorative line at a fixed box; the number beside it is what assistive technology reads. */
export function TelemetryWidgetLine(
  props: Readonly<{
    series: HappierSeries | null;
    variant: 'line' | 'area';
    width?: number;
    height: number;
    color?: string;
    testID?: string;
  }>,
): React.ReactElement {
  const theme = usePluginTheme();
  const color =
    props.color ??
    (props.variant === 'area'
      ? theme.colors.accent
      : theme.colors.secondaryText);
  const series = React.useMemo(
    () => (props.series ? [{ ...props.series, color }] : null),
    [color, props.series],
  );
  // No interval yet is not a reading of zero: the line keeps its room and draws nothing.
  const drawn =
    series !== null &&
    series[0]!.points.some((point) => typeof point.y === 'number');
  return (
    <Stack
      testID={props.testID}
      gap="none"
      style={{
        height: props.height,
        ...(props.width === undefined
          ? { alignSelf: 'stretch' }
          : { width: props.width }),
      }}
    >
      {drawn ? (
        <StackedSeriesChart
          theme={theme}
          label=""
          series={series}
          variant={props.variant}
          size="inline"
          {...(props.width === undefined ? {} : { width: props.width })}
          viewportHeight={props.height}
          strokeWidth={1.25}
          showAxis={false}
          showLegend={false}
          showGrid={false}
          showReadout={false}
          decorative
        />
      ) : null}
    </Stack>
  );
}

/**
 * Every state but `ready`, said once. No traffic yet is the shipped "nothing listening" scene; a read
 * that failed with nothing retained is the shared error block with Retry.
 */
export function TelemetryWidgetState(
  props: Readonly<{
    state: Exclude<TelemetryWidgetReadState<unknown>, { kind: 'ready' }>;
    retry: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const text = usePluginTranslation();
  switch (props.state.kind) {
    case 'unbound':
      return (
        <EmptyState
          testID={`${props.testID}.unbound`}
          title={text(
            'plugins.telemetry.widgets.chooseEnvironment',
            'Choose an Environment',
          )}
          description={text(
            'plugins.telemetry.widgets.chooseEnvironmentDescription',
            'Pick an Environment that sends telemetry.',
          )}
        />
      );
    case 'loading':
      return <LoadingState testID={`${props.testID}.loading`} />;
    case 'quiet':
      return (
        <EmptyState
          testID={`${props.testID}.quiet`}
          scene="nothingListening"
          title={text(
            'plugins.telemetry.widgets.waiting',
            'Waiting for traffic',
          )}
          description={text(
            'plugins.telemetry.widgets.waitingDescription',
            'Numbers appear once the app serves requests.',
          )}
        />
      );
    case 'unavailable':
      return (
        <ErrorState
          testID={`${props.testID}.unavailable`}
          title={text(
            'plugins.telemetry.widgets.unavailable',
            'Telemetry is unavailable',
          )}
          description={props.state.failure.message}
          details={props.state.failure.code}
          onRetry={props.retry}
        />
      );
  }
}

/** A later read failed: what is on screen stays, and this one line says since when. */
export function TelemetryWidgetStale(
  props: Readonly<{
    state: Extract<TelemetryWidgetReadState<unknown>, { kind: 'ready' }>;
    retry: () => void;
    testID: string;
  }>,
): React.ReactElement | null {
  const text = usePluginTranslation();
  if (props.state.failure === null) return null;
  return (
    <FreshnessLine
      testID={`${props.testID}.stale`}
      asOf={props.state.readAtMs}
      tone="warning"
      reason={props.state.failure.message}
      action={{
        label: text('plugins.telemetry.widgets.retry', 'Retry'),
        onPress: props.retry,
      }}
    />
  );
}
