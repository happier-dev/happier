import { useState } from 'react';
import { View } from 'react-native';

import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE, useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HappierDataRows } from './DataRows.js';
import { formatHappierDataValue, resolveHappierDataDomainFraction } from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';

function finiteDomain(values: readonly (number | null)[]): readonly [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return min === Infinity ? null : [min, max];
}

export type OutcomeScatterPoint = Readonly<{
  id: string;
  label: string;
  x: number | null;
  y: number | null;
  color?: string;
  annotation?: string;
  /** The caller chose to name this point on the plot (an outlier); every point stays in the rows. */
  labelled?: boolean;
}>;

/** A supplied reference value on the x axis (a median the caller computed); never derived here. */
export type OutcomeScatterGuide = Readonly<{ id: string; value: number; label: string }>;

export type OutcomeScatterProps = Readonly<{
  theme: HappierUiTheme;
  label: string;
  points: readonly OutcomeScatterPoint[];
  xLabel: string;
  yLabel: string;
  xGuides?: readonly OutcomeScatterGuide[];
  /** What each supplied point colour stands for; the caller owns the grouping and its words. */
  legend?: readonly Readonly<{ id: string; label: string; color: string }>[];
  /** The x domain's own exact wording (money); it replaces the generic number on the axis, rows and guides. */
  formatX?: (value: number) => string;
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  basis?: string;
  unknownLabel?: string;
  size?: 'inline' | 'tile' | 'full';
  geometry?: Readonly<{ width: number; height: number }>;
  testID?: string;
}>;

export function OutcomeScatter(props: OutcomeScatterProps) {
  const text = useHappierDataTextStyles(props.theme);
  const nativeTarget = useHappierNativeMinimumInteractiveTargetSize();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const unknown = props.unknownLabel ?? 'Unknown';
  const format = (value: number | null) => value !== null && Number.isFinite(value) ? formatHappierDataValue(value, text.locale) : unknown;
  const formatX = (value: number | null) => value !== null && Number.isFinite(value) && props.formatX ? props.formatX(value) : format(value);
  const describe = (point: OutcomeScatterPoint) => [point.label, `${props.xLabel}: ${formatX(point.x)}`, `${props.yLabel}: ${format(point.y)}`,
    point.annotation, props.basis].filter(Boolean).join(', ');
  const complete = props.points.filter((point) => point.x !== null && point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y));
  const xDomain = props.xDomain ?? finiteDomain(complete.map((point) => point.x));
  const yDomain = props.yDomain ?? finiteDomain(complete.map((point) => point.y));
  const width = props.geometry?.width ?? measuredWidth;
  const target = nativeTarget ?? HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE;
  const plotHeight = props.geometry === undefined ? HAPPIER_DATA_METRICS.plotHeightPx * 2
    : props.geometry.height - (text.caption.lineHeight ?? props.theme.typography.caption.lineHeight) * 3
      - target - HAPPIER_DATA_METRICS.axisGapPx;
  const showPlot = (props.size ?? 'full') === 'full' && xDomain !== null && yDomain !== null
    && resolveHappierDataDomainFraction(xDomain[0], ...xDomain) !== null && resolveHappierDataDomainFraction(yDomain[0], ...yDomain) !== null
    && Number.isFinite(plotHeight) && plotHeight > target && (width === null || Number.isFinite(width) && width >= target * 2);
  const vertices = complete.flatMap((point) => {
    if (xDomain === null || yDomain === null) return [];
    const x = resolveHappierDataDomainFraction(point.x, ...xDomain);
    const y = resolveHappierDataDomainFraction(point.y, ...yDomain);
    return x === null || y === null ? [] : [{ point, x, y: 1 - y }];
  });
  const selected = props.points.find((point) => point.id === selectedId);
  const captionLine = text.caption.lineHeight ?? props.theme.typography.caption.lineHeight;
  const guides = (props.xGuides ?? []).filter((guide) => Number.isFinite(guide.value));
  const radius = HAPPIER_DATA_METRICS.lineStrokePx * 2;

  return <View testID={props.testID} onLayout={(event: HappierLayoutChangeEvent) => setMeasuredWidth(event.nativeEvent.layout.width)}
    style={{ gap: HAPPIER_DATA_METRICS.blockGapPx }}>
    {props.basis ? <HappierText style={text.caption}>{props.basis}</HappierText> : null}
    {showPlot && xDomain && yDomain ? <View testID={props.testID ? `${props.testID}-plot` : undefined}>
      <HappierText style={text.caption}>{props.yLabel}</HappierText>
      <View style={{ height: plotHeight, marginHorizontal: target / 2, marginVertical: target / 2,
        borderBottomWidth: 1, borderLeftWidth: 1, borderColor: props.theme.colors.divider }}>
        {xDomain === null ? null : guides.map((guide) => {
          const at = resolveHappierDataDomainFraction(guide.value, ...xDomain);
          return at === null ? null : <View key={guide.id} aria-hidden importantForAccessibility="no-hide-descendants"
            testID={props.testID ? `${props.testID}-guide-${guide.id}` : undefined}
            style={{ position: 'absolute', left: `${at * 100}%`, top: 0, bottom: 0, borderLeftWidth: 1, borderStyle: 'dashed',
              borderColor: props.theme.colors.mutedText }} />;
        })}
        {vertices.filter((vertex) => vertex.point.labelled).map((vertex) => {
          // The name sits on the side with room, at the mark's height; it is ink only, the rows speak it.
          const before = vertex.x > 0.5;
          return <View key={`label-${vertex.point.id}`} aria-hidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
            style={{ position: 'absolute', top: `${vertex.y * 100}%`, transform: [{ translateY: -captionLine / 2 }],
              ...(before ? { left: 0, right: `${(1 - vertex.x) * 100}%`, paddingRight: radius * 2 }
                : { left: `${vertex.x * 100}%`, right: 0, paddingLeft: radius * 2 }) }}>
            <HappierText testID={props.testID ? `${props.testID}-label-${vertex.point.id}` : undefined} numberOfLines={1}
              style={{ ...text.caption, color: props.theme.colors.secondaryText, textAlign: before ? 'right' : 'left' }}>{vertex.point.label}</HappierText>
          </View>;
        })}
        {vertices.map((vertex) => {
          // All values remain in the list. A dense plot cannot offer overlapping touch targets:
          // only isolated marks get a selection control, using the shared platform target baseline.
          const isolated = width !== null && vertices.every((other) => other === vertex
            || Math.abs(other.x - vertex.x) * Math.max(0, width - target) >= target || Math.abs(other.y - vertex.y) * plotHeight >= target);
          return <View key={vertex.point.id} testID={props.testID ? `${props.testID}-point-${vertex.point.id}` : undefined}
            style={{ position: 'absolute', left: `${vertex.x * 100}%`, top: `${vertex.y * 100}%` }}>
            <View aria-hidden importantForAccessibility="no-hide-descendants" style={{ width: radius * 2, height: radius * 2,
              borderRadius: radius, backgroundColor: vertex.point.color ?? props.theme.colors.info,
              transform: [{ translateX: -radius }, { translateY: -radius }] }} />
            {isolated ? <HappierPressable testID={props.testID ? `${props.testID}-select-${vertex.point.id}` : undefined}
              accessibilityRole="button" accessibilityLabel={describe(vertex.point)} selected={selectedId === vertex.point.id}
              onPress={() => setSelectedId(vertex.point.id)} onFocusChange={(focused) => { if (focused) setSelectedId(vertex.point.id); }}
              style={{ position: 'absolute', width: target, height: target, top: -target / 2, left: -target / 2,
                borderRadius: target / 2, borderWidth: selectedId === vertex.point.id ? 1 : 0, borderColor: props.theme.colors.text }} /> : null}
          </View>;
        })}
      </View>
      <View aria-hidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <HappierText style={{ ...text.caption, flexShrink: 1 }} numberOfLines={1} tabularNumbers>{formatX(xDomain[0])}</HappierText>
        <HappierText style={{ ...text.caption, flexShrink: 1, textAlign: 'right' }} numberOfLines={1} tabularNumbers>{formatX(xDomain[1])}</HappierText>
      </View>
      <HappierText style={text.caption}>{props.xLabel}</HappierText>
    </View> : null}
    {showPlot && props.legend && props.legend.length > 0 ? <View testID={props.testID ? `${props.testID}-legend` : undefined}
      style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: HAPPIER_DATA_METRICS.blockGapPx, rowGap: HAPPIER_DATA_METRICS.axisGapPx }}>
      {props.legend.map((entry) => <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'center', gap: HAPPIER_DATA_METRICS.axisGapPx }}>
        <View style={{ width: radius * 2, height: radius * 2, borderRadius: radius, backgroundColor: entry.color }} />
        <HappierText style={text.caption}>{entry.label}</HappierText>
      </View>)}
    </View> : null}
    {guides.length > 0 ? <View testID={props.testID ? `${props.testID}-guides` : undefined}>
      {guides.map((guide) => <HappierText key={guide.id} style={text.caption} tabularNumbers>{`${guide.label}: ${formatX(guide.value)}`}</HappierText>)}
    </View> : null}
    {selected ? <HappierText testID={props.testID ? `${props.testID}-readout` : undefined} style={text.captionStrong}
      accessibilityLiveRegion="polite" tabularNumbers>{describe(selected)}</HappierText> : null}
    <HappierDataRows theme={props.theme} label={props.label} testID={props.testID ? `${props.testID}-values` : undefined}
      density={props.size === 'inline' || props.size === 'tile' ? 'compact' : 'comfortable'}
      rowIds={props.points.map((point) => point.id)}
      columns={[{ label: props.label }, { label: props.xLabel }, { label: props.yLabel }, { label: 'Annotation' }]}
      rows={props.points.map((point) => [point.label, formatX(point.x), format(point.y), ...(point.annotation ? [point.annotation] : [])])} />
  </View>;
}
