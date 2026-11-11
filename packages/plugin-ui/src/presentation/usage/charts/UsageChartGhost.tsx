import type { ReactElement } from 'react';
import { Circle, Line, Svg } from 'react-native-svg';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../../environment/types.js';
import {
  resolveUsageChartInk,
  useUsageChartSvgText,
  useUsageChartWidth,
  type UsageChartPaint,
} from './chartKit.js';

/** Which chart's empty frame to draw: the shape a reader will see once the measure is recorded. */
export type UsageChartGhostShape =
  | 'sky'
  | 'tide'
  | 'daylight'
  | 'lanes'
  | 'runs';

const HEIGHT: Readonly<Record<UsageChartGhostShape, number>> = {
  sky: 64,
  tide: 150,
  daylight: 116,
  lanes: 120,
  runs: 120,
};
const AXIS = 18;

/**
 * A chart's frame with nothing in it: its axis, its rows and one "not recorded" ring per slot, in quiet ink. It holds
 * the chart's own footprint while a measure is unrecorded or empty, so the page keeps its shape and the state's
 * reason (said once, by the host, above it) reads against the chart it explains. It carries no values and is hidden
 * from assistive technology.
 */
export function UsageChartGhost(
  props: Readonly<{
    theme: HappierUiTheme;
    paint: UsageChartPaint;
    shape: UsageChartGhostShape;
    /** Slots along the period (Sky: its days). */
    count?: number;
    /** Row names in the leading gutter (Week tide: weekdays; Lanes and Run length: Agents). Absent rows stay unnamed. */
    rows?: readonly string[];
    /** Evenly spaced axis labels under the plot, first at its start and last at its end. */
    ticks?: readonly string[];
    width?: number;
    testID?: string;
  }>,
) {
  const [measured, onLayout] = useUsageChartWidth(props.width);
  const ink = resolveUsageChartInk(props.theme, props.paint);
  const text = useUsageChartSvgText(props.theme);
  const height = HEIGHT[props.shape];
  const width = measured ?? 0;
  const rows = props.rows ?? [];
  const gutter = rows.length
    ? Math.min(
        96,
        Math.max(...rows.map((row) => row.length)) * text.fontSize * 0.6 + 12,
      )
    : 0;
  const left = gutter;
  const right = width;
  const plot = Math.max(0, right - left);
  const ticks = props.ticks ?? [];
  const tickY = height - 4;
  const plotBottom = ticks.length ? height - AXIS - 4 : height;
  const marks: ReactElement[] = [];

  if (width > 0 && props.shape === 'sky') {
    const count = Math.max(1, props.count ?? 30);
    const step = plot / count;
    const r = Math.max(1.5, Math.min(3.5, step * 0.32));
    const mid = plotBottom / 2;
    // The horizon the days sit on, then each day as a ring: drawn, but not recorded.
    marks.push(
      <Line
        key="horizon"
        x1={left}
        x2={right}
        y1={mid}
        y2={mid}
        stroke={ink.base}
        strokeOpacity={0.7}
        strokeWidth={1.2}
        strokeDasharray="1 5"
        strokeLinecap="round"
      />,
    );
    for (let index = 0; index < count; index++)
      marks.push(
        <Circle
          key={index}
          cx={left + step * (index + 0.5)}
          cy={mid}
          r={r}
          fill={props.paint.paper}
          stroke={ink.neutral}
          strokeOpacity={0.6}
          strokeWidth={1.1}
        />,
      );
  }
  const rowCount =
    props.shape === 'tide'
      ? Math.max(rows.length, 7)
      : props.shape === 'daylight'
        ? 5
        : Math.max(rows.length, 3);
  const rowHeight = plotBottom / rowCount;
  if (
    width > 0 &&
    (props.shape === 'tide' ||
      props.shape === 'lanes' ||
      props.shape === 'runs')
  ) {
    for (let index = 0; index < rowCount; index++) {
      const y = rowHeight * (index + 0.5);
      if (props.shape === 'tide')
        marks.push(
          <Line
            key={index}
            x1={left}
            x2={right}
            y1={y + rowHeight * 0.3}
            y2={y + rowHeight * 0.3}
            stroke={ink.base}
            strokeOpacity={0.6}
            strokeWidth={1}
          />,
        );
      // A lane with nothing on it is a dotted guide, never a filled bar a reader could take for loading.
      else
        marks.push(
          <Line
            key={index}
            x1={left}
            x2={right}
            y1={y}
            y2={y}
            stroke={ink.base}
            strokeOpacity={0.7}
            strokeWidth={1.2}
            strokeDasharray="1 5"
            strokeLinecap="round"
          />,
        );
    }
  }
  if (width > 0 && props.shape === 'daylight') {
    const columns = 24;
    const step = plot / columns;
    const r = Math.max(1.5, Math.min(3, step * 0.22));
    for (let column = 0; column < columns; column++)
      for (let row = 0; row < rowCount; row++)
        marks.push(
          <Circle
            key={`${column}:${row}`}
            cx={left + step * (column + 0.5)}
            cy={rowHeight * (row + 0.5)}
            r={r}
            fill={ink.track}
          />,
        );
  }
  rows.forEach((row, index) =>
    marks.push(
      text.draw(
        {
          x: 0,
          y: rowHeight * (index + 0.5) + text.fontSize * 0.35,
          text: row,
          tone: 'muted',
        },
        `row:${index}`,
      ),
    ),
  );
  ticks.forEach((tick, index) => {
    const x =
      ticks.length === 1
        ? left + plot / 2
        : left + (plot * index) / (ticks.length - 1);
    marks.push(
      text.draw(
        {
          x,
          y: tickY,
          text: tick,
          tone: 'muted',
          anchor:
            index === 0
              ? 'start'
              : index === ticks.length - 1
                ? 'end'
                : 'middle',
        },
        `tick:${index}`,
      ),
    );
  });

  return (
    <View
      testID={props.testID}
      onLayout={onLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ minWidth: 0, height }}
    >
      {width > 0 ? (
        <Svg accessible={false} aria-hidden width={width} height={height}>
          {marks}
        </Svg>
      ) : null}
    </View>
  );
}
