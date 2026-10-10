import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE, useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierDataHatch } from '../content/Hatch.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HappierDataRows } from './DataRows.js';
import { formatHappierDataValue, resolveHappierDataDomainFraction } from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';

export type IntervalTimelineInterval = Readonly<{
  id: string;
  label: string;
  /** A point has one witnessed coordinate; it never implies a duration or unknown end. */
  kind?: 'interval' | 'point';
  /** Coordinates in the consumer's stated domain; no time, activity or duration is inferred. */
  start: number | null;
  /** Missing end draws only a known start marker, never an assumed continuing span. */
  end: number | null;
  startLabel?: string;
  endLabel?: string;
  color?: string;
  /** A source-provided texture; any meaning belongs in the consumer's label or annotation. */
  pattern?: 'solid' | 'hatched';
  annotation?: string;
}>;

export type IntervalTimelineProps = Readonly<{
  theme: HappierUiTheme;
  label: string;
  intervals: readonly IntervalTimelineInterval[];
  domain: Readonly<{ start: number; end: number }>;
  startLabel?: string;
  endLabel?: string;
  basis?: string;
  unknownLabel?: string;
  size?: 'inline' | 'tile' | 'full';
  geometry?: Readonly<{ width: number; height: number }>;
  /**
   * The domain's own exact wording (a clock time for minutes of a day). It replaces the generic
   * number on the axis, rows and readout; without it the finite coordinate is stated as a number.
   */
  formatValue?: (value: number) => string;
  /** Domain-owned marker ink, placed by the shared timeline geometry. */
  renderMarker?: (interval: IntervalTimelineInterval) => ReactNode;
  testID?: string;
}>;

export function IntervalTimeline(props: IntervalTimelineProps) {
  const text = useHappierDataTextStyles(props.theme);
  const nativeTarget = useHappierNativeMinimumInteractiveTargetSize();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const unknown = props.unknownLabel ?? 'Unknown';
  const startLabel = props.startLabel ?? 'Start';
  const endLabel = props.endLabel ?? 'End';
  const format = (value: number | null, label?: string) => {
    const exact = value !== null && Number.isFinite(value)
      ? props.formatValue?.(value) ?? formatHappierDataValue(value, text.locale) : unknown;
    return label && label !== exact ? `${label} (${exact})` : exact;
  };
  const hasIntervals = props.intervals.some(interval => interval.kind !== 'point');
  const rowValues = (interval: IntervalTimelineInterval) => [interval.label, format(interval.start, interval.startLabel),
    ...(hasIntervals ? [interval.kind === 'point' ? '' : format(interval.end, interval.endLabel)] : []), interval.annotation ?? ''];
  const describe = (interval: IntervalTimelineInterval) => [interval.label, `${startLabel}: ${format(interval.start, interval.startLabel)}`,
    interval.kind === 'point' ? null : `${endLabel}: ${format(interval.end, interval.endLabel)}`, interval.annotation, props.basis].filter(Boolean).join(', ');
  const selected = props.intervals.find((interval) => interval.id === selectedId);
  const width = props.geometry?.width ?? measuredWidth;
  const axisStart = format(props.domain.start);
  const axisEnd = format(props.domain.end);
  const captionWidth = (text.caption.fontSize ?? props.theme.typography.caption.fontSize) * HAPPIER_DATA_METRICS.averageCharacterEm;
  const axisFits = width === null || Number.isFinite(width) && width >= (axisStart.length + axisEnd.length) * captionWidth + HAPPIER_DATA_METRICS.columnGapPx;
  const rowHeight = Math.max(nativeTarget ?? HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
    (text.body.lineHeight ?? props.theme.typography.body.lineHeight) + HAPPIER_DATA_METRICS.cellPaddingVerticalPx * 2);
  const requiredHeight = props.intervals.length * rowHeight + (text.caption.lineHeight ?? props.theme.typography.caption.lineHeight)
    + HAPPIER_DATA_METRICS.axisGapPx;
  const heightFits = props.geometry === undefined || Number.isFinite(props.geometry.height) && props.geometry.height >= requiredHeight;
  const validDomain = Number.isFinite(props.domain.start) && Number.isFinite(props.domain.end) && props.domain.start < props.domain.end;
  const showPlot = (props.size ?? 'full') === 'full' && validDomain && axisFits && heightFits && props.intervals.length > 0;

  return <View testID={props.testID} onLayout={(event: HappierLayoutChangeEvent) => setMeasuredWidth(event.nativeEvent.layout.width)}
    style={{ gap: HAPPIER_DATA_METRICS.blockGapPx }}>
    {props.basis ? <HappierText style={text.caption}>{props.basis}</HappierText> : null}
    {showPlot ? <View testID={props.testID ? `${props.testID}-plot` : undefined}>
      {props.intervals.map((interval) => {
        const start = resolveHappierDataDomainFraction(interval.start, props.domain.start, props.domain.end);
        const end = interval.kind === 'point' ? null : resolveHappierDataDomainFraction(interval.end, props.domain.start, props.domain.end);
        const witnessed = interval.kind !== 'point' && interval.start !== null && interval.end !== null && Number.isFinite(interval.start)
          && Number.isFinite(interval.end) && interval.start <= interval.end;
        const clippedStart = witnessed ? resolveHappierDataDomainFraction(Math.max(props.domain.start, interval.start!), props.domain.start, props.domain.end) : null;
        const clippedEnd = witnessed ? resolveHappierDataDomainFraction(Math.min(props.domain.end, interval.end!), props.domain.start, props.domain.end) : null;
        const color = interval.color ?? props.theme.colors.info;
        return <HappierPressable key={interval.id} testID={props.testID ? `${props.testID}-select-${interval.id}` : undefined}
          accessibilityRole="button" accessibilityLabel={describe(interval)} selected={selectedId === interval.id}
          onPress={() => setSelectedId(interval.id)} onFocusChange={(focused) => { if (focused) setSelectedId(interval.id); }}
          style={{ minHeight: rowHeight, justifyContent: 'center' }}>
          <View aria-hidden importantForAccessibility="no-hide-descendants">
            <HappierText style={text.caption}>{interval.label}</HappierText>
            <View style={{ height: HAPPIER_DATA_METRICS.proportionHeightPx, marginTop: HAPPIER_DATA_METRICS.axisGapPx }}>
              <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, backgroundColor: props.theme.colors.divider }} />
              {clippedStart !== null && clippedEnd !== null && clippedEnd > clippedStart ? <View
                testID={props.testID ? `${props.testID}-interval-${interval.id}` : undefined}
                style={{ position: 'absolute', left: `${clippedStart * 100}%`, width: `${(clippedEnd - clippedStart) * 100}%`,
                  height: HAPPIER_DATA_METRICS.proportionHeightPx, borderRadius: HAPPIER_DATA_METRICS.barRadiusPx, overflow: 'hidden', backgroundColor: color }}>
                {interval.pattern === 'hatched' ? <HappierDataHatch theme={props.theme} /> : null}
              </View> : null}
              {start !== null ? <View testID={props.testID ? `${props.testID}-start-${interval.id}` : undefined}
                style={{ position: 'absolute', left: `${start * 100}%`, ...(props.renderMarker ? {} : {
                  width: HAPPIER_DATA_METRICS.lineStrokePx, height: HAPPIER_DATA_METRICS.proportionHeightPx, backgroundColor: color }) }}>
                {props.renderMarker?.(interval)}
              </View> : null}
              {end !== null ? <View testID={props.testID ? `${props.testID}-end-${interval.id}` : undefined}
                style={{ position: 'absolute', left: `${end * 100}%`, width: HAPPIER_DATA_METRICS.lineStrokePx,
                  height: HAPPIER_DATA_METRICS.proportionHeightPx, backgroundColor: color }} /> : null}
            </View>
          </View>
        </HappierPressable>;
      })}
      <View aria-hidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <HappierText style={text.caption} tabularNumbers>{axisStart}</HappierText>
        <HappierText style={text.caption} tabularNumbers>{axisEnd}</HappierText>
      </View>
    </View> : null}
    {selected ? <HappierText testID={props.testID ? `${props.testID}-readout` : undefined} style={text.captionStrong}
      accessibilityLiveRegion="polite" tabularNumbers>{describe(selected)}</HappierText> : null}
    <HappierDataRows theme={props.theme} label={props.label} testID={props.testID ? `${props.testID}-values` : undefined}
      density={props.size === 'inline' || props.size === 'tile' ? 'compact' : 'comfortable'}
      rowIds={props.intervals.map((interval) => interval.id)}
      columns={[{ label: props.label }, { label: startLabel }, ...(hasIntervals ? [{ label: endLabel }] : []), { label: 'Annotation' }]}
      rows={props.intervals.map(rowValues)} />
  </View>;
}
