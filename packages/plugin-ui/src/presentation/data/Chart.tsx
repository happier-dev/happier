import { useState } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import {
  describeHappierDataChart,
  formatHappierDataValue,
  resolveHappierDataBarHeights,
  resolveHappierDataLinePoints,
  resolveHappierDataLineSegments,
  type HappierDataPoint,
} from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';

export type HappierDataChartProps = Readonly<{
  /** The series' name ("Signups per day"); it leads what the chart says to assistive technology. */
  label: string;
  /** `bar` for counts per period, `line` for a rate over time. */
  style: 'bar' | 'line';
  points: readonly HappierDataPoint[];
  theme: HappierUiTheme;
  testID?: string;
}>;

type BarAxis = 'every' | 'ends';

/**
 * One series (lab DP "Chart"). Bars rest in a quiet ink and the current period — the last one — is
 * the one strong bar; a line is a 2 pt stroke on a hairline baseline with its first and last labels.
 * The whole chart is one image to assistive technology whose label names every point, so its data is
 * never colour- or shape-only. Hovering a bar shows its value; nothing moves.
 */
export function HappierDataChart(props: HappierDataChartProps) {
  const text = useHappierDataTextStyles(props.theme);
  const [width, setWidth] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const plotHeight = HAPPIER_DATA_METRICS.plotHeightPx;
  const count = props.points.length;
  // Every bar keeps its label while each fits its column; otherwise only the ends say where it starts and stops.
  const labelWidth = (text.caption.fontSize ?? props.theme.typography.caption.fontSize) * HAPPIER_DATA_METRICS.averageCharacterEm * 3;
  const barAxis: BarAxis = width !== null && count > 0 && (width - HAPPIER_DATA_METRICS.barGapPx * (count - 1)) / count < labelWidth ? 'ends' : 'every';
  const hoveredPoint = hovered === null ? null : props.points[hovered] ?? null;
  const baseline = { borderBottomWidth: 1, borderBottomColor: props.theme.colors.divider };

  const plot = props.style === 'bar' ? (
    <View style={{ height: plotHeight, flexDirection: 'row', alignItems: 'flex-end', columnGap: HAPPIER_DATA_METRICS.barGapPx, ...baseline }}>
      {resolveHappierDataBarHeights(props.points, plotHeight, HAPPIER_DATA_METRICS.barStubPx).map((height, index) => {
        const current = index === count - 1;
        return (
          <View
            key={index}
            testID={props.testID ? `${props.testID}-bar-${index}` : undefined}
            onPointerEnter={() => setHovered(index)}
            onPointerLeave={() => setHovered((previous) => (previous === index ? null : previous))}
            style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}
          >
            <View style={{ height, borderTopLeftRadius: HAPPIER_DATA_METRICS.barRadiusPx, borderTopRightRadius: HAPPIER_DATA_METRICS.barRadiusPx,
              backgroundColor: current ? props.theme.colors.info : props.theme.colors.text,
              opacity: current || hovered === index ? 1 : HAPPIER_DATA_METRICS.barRestOpacity }} />
          </View>
        );
      })}
    </View>
  ) : (
    <View style={{ height: plotHeight, ...baseline }}>
      {width === null ? null : resolveHappierDataLineSegments(resolveHappierDataLinePoints(props.points, width, plotHeight - 1, HAPPIER_DATA_METRICS.lineStrokePx))
        .map((segment, index) => (
          <View
            key={index}
            testID={props.testID ? `${props.testID}-segment-${index}` : undefined}
            style={{ position: 'absolute', left: segment.centerX - segment.length / 2, top: segment.centerY - HAPPIER_DATA_METRICS.lineStrokePx / 2,
              width: segment.length, height: HAPPIER_DATA_METRICS.lineStrokePx, borderRadius: HAPPIER_DATA_METRICS.lineStrokePx / 2,
              backgroundColor: props.theme.colors.text, transform: [{ rotate: `${segment.angle}deg` }] }}
          />
        ))}
    </View>
  );

  const axisLabel = (index: number) => {
    const point = props.points[index];
    return point === undefined ? '' : formatHappierDataValue(point.x, text.locale);
  };
  const axis = count === 0 ? null : props.style === 'bar' && barAxis === 'every' ? (
    <View style={{ flexDirection: 'row', columnGap: HAPPIER_DATA_METRICS.barGapPx, marginTop: HAPPIER_DATA_METRICS.axisGapPx }}>
      {props.points.map((_, index) => (
        <HappierText key={index} style={{ ...text.caption, flex: 1, textAlign: 'center' }} numberOfLines={1} tabularNumbers>{axisLabel(index)}</HappierText>
      ))}
    </View>
  ) : (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: HAPPIER_DATA_METRICS.axisGapPx }}>
      <HappierText style={text.caption} numberOfLines={1} tabularNumbers>{axisLabel(0)}</HappierText>
      {count > 1 ? <HappierText style={text.caption} numberOfLines={1} tabularNumbers>{axisLabel(count - 1)}</HappierText> : null}
    </View>
  );

  return (
    <View
      testID={props.testID}
      role="img"
      accessibilityLabel={describeHappierDataChart(props.label, props.points, text.locale)}
      onLayout={(event: HappierLayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
    >
      <View aria-hidden importantForAccessibility="no-hide-descendants">
        {plot}
        {axis}
        {hoveredPoint ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0 }}>
            <HappierText testID={props.testID ? `${props.testID}-readout` : undefined} style={text.captionStrong} tabularNumbers>
              {`${formatHappierDataValue(hoveredPoint.x, text.locale)} · ${formatHappierDataValue(hoveredPoint.y, text.locale)}`}
            </HappierText>
          </View>
        ) : null}
      </View>
    </View>
  );
}
