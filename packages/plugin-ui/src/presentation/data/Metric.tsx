import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import { useOptionalHappierUiTypography } from '../../environment/context.js';
import { formatHappierDataValue, formatHappierDataValueWithPrecision, type HappierDataValue } from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';
import { ChartDatum, useChartInteractionAvailable } from './ChartDatum.js';
import { HappierSkeletonTitle } from '../feedback/Skeleton.js';

/** One comparison under a metric ("+18% vs the week before"), coloured only by what it means. */
export type HappierDataMetricComparison = Readonly<{
  value: string;
  /** Words after the value ("vs the week before"). */
  label: string;
  /** `good` and `bad` are meanings, not directions: a falling error rate is good. */
  meaning: 'good' | 'bad' | 'neutral';
}>;

export type HappierDataMetricProps = Readonly<{
  /** What the number counts; read to assistive technology, and shown above it when `showLabel`. */
  label: string;
  value: HappierDataValue;
  unit?: string;
  comparison?: HappierDataMetricComparison;
  /**
   * `stat` size, while a comparison is still being read: its text, invisible and hidden from assistive
   * technology, so the line's room is held and the comparison's arrival moves nothing below it.
   * Ignored once `comparison` is given.
   */
  comparisonRoom?: Readonly<{ value: string; label: string }>;
  /**
   * `hero` is the one number a widget is about (the period's total); `stat` is one of a row of
   * labelled facts; `default` keeps the original metric node.
   */
  size?: 'hero' | 'stat' | 'default';
  /** Hide the rendered metric from assistive technology when its reading is supplied separately. */
  decorative?: boolean;
  /** Draw the label above the number (several facts in one widget). */
  showLabel?: boolean;
  /** One quiet line under the number ("plans + pay-as-you-go"). */
  caption?: string;
  /**
   * The number is a state that needs the person (a check over its limit, a target that cannot answer): drawn in that
   * state's text ink. Absent, the number stays ink; a figure is never coloured for being high or low on its own.
   */
  tone?: 'warning' | 'danger';
  /** Visible ink only ("721M"); assistive technology keeps the exact value. */
  valueFormatter?: (value: number) => string;
  /**
   * The figure's first read is still in flight: the metric keeps its own shape, each data line (the value, a given
   * comparison, a given caption, even an empty one) held by the quiet loading bar in that line's box, while a shown
   * label stays ink. Nothing moves when the figure lands.
   */
  pending?: boolean;
  /** Custom ink for an inline figure. The metric still owns the accessible reading. */
  children?: ReactNode;
  theme: HappierUiTheme;
  testID?: string;
}>;

const metricInk = {
  'aria-hidden': true,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

const NO_BREAK_SPACE = '\u00a0';
/** The room a figure still being read holds: a four-figure count, the width most glance figures land in. */
const PENDING_FIGURE = '0,000';

function bindNumbersToUnits(text: string): string {
  return text.replace(/(\d) (?=[^\d\s])/gu, `$1${NO_BREAK_SPACE}`);
}

/**
 * One number, its unit and one comparison (lab DP "Metric"). Tabular figures so a refreshed value
 * never jitters; the comparison is coloured by meaning, never by sign.
 */
export function HappierDataMetric(props: HappierDataMetricProps) {
  const text = useHappierDataTextStyles(props.theme);
  const typography = useOptionalHappierUiTypography();
  const chartInteractionAvailable = useChartInteractionAvailable();
  const exact = formatHappierDataValue(props.value, text.locale);
  const value =
    typeof props.value === 'number' &&
    Number.isFinite(props.value) &&
    props.valueFormatter
      ? props.valueFormatter(props.value)
      : exact;
  const preciseValue = formatHappierDataValueWithPrecision(exact, value);
  const spokenValue = props.unit ? `${preciseValue} ${props.unit}` : preciseValue;
  const accessibilityLabel = props.pending ? props.label : [
    `${props.label}: ${spokenValue}`,
    props.comparison ? `${props.comparison.value} ${props.comparison.label}` : null,
    props.caption,
  ].filter(Boolean).join(', ');
  // Only abbreviated or rounded ink needs an exact tooltip. A mounted trigger owns its accessible name.
  const hasExactTooltip = !props.pending && typeof props.value === 'number' && Number.isFinite(props.value) && !value.includes(exact);
  const hideVisual = props.decorative || (hasExactTooltip && chartInteractionAvailable);
  const size = props.size ?? 'default';
  const comparisonColor = props.theme.colors.text;
  const valueColor = props.tone ? props.theme.statusText?.[props.tone] ?? props.theme.colors[props.tone] : props.theme.colors.text;
  const valueStyle =
    size === 'hero'
      ? {
          ...resolveHappierTextStepStyle(
            HAPPIER_DATA_METRICS.heroValue,
            typography,
          ),
          color: valueColor,
        }
      : size === 'stat'
        ? {
            ...resolveHappierTextStepStyle(
              HAPPIER_DATA_METRICS.statValue,
              typography,
            ),
            color: valueColor,
          }
        : props.tone ? { ...text.metric, color: valueColor } : text.metric;
  // A figure still arriving holds its whole line, unit included, with one bar: the line's box is the value's.
  const inlineUnit = size !== 'default' && !props.pending && props.unit;
  // A number is bound to the unit that follows it, so a narrow cell wraps between "3 h" and
  // "22 min" and never leaves "min" alone on a line.
  const shown = bindNumbersToUnits(
    props.unit && !inlineUnit ? `${value} ${props.unit}` : value,
  );
  const comparison = props.pending ? (props.comparison || props.comparisonRoom ? (
    <HappierSkeletonTitle theme={props.theme} lineHeight={text.caption.lineHeight ?? props.theme.typography.caption.lineHeight} line="meta" />
  ) : null) : props.comparison ? (
    size === 'hero' ? (
      <View
        style={{
          alignSelf: 'center',
          borderRadius: props.theme.radii.small,
          paddingHorizontal: props.theme.spacing.xsmall + 2,
          paddingVertical: 1,
          backgroundColor: props.theme.colors.control,
        }}
      >
        <HappierText
          style={{ ...text.captionStrong, color: comparisonColor }}
          tabularNumbers
        >
          {props.comparison.value}
        </HappierText>
      </View>
    ) : (
      <View
        {...metricInk}
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          columnGap: HAPPIER_DATA_METRICS.comparisonGapPx,
        }}
      >
        <HappierText
          style={{ ...text.captionStrong, color: comparisonColor }}
          tabularNumbers
        >
          {props.comparison.value}
        </HappierText>
        <HappierText style={text.caption}>{props.comparison.label}</HappierText>
      </View>
    )
  ) : null;
  const visual = (
    <View
      testID={props.testID}
      accessible={!hideVisual}
      role={hideVisual ? undefined : 'group'}
      {...(hideVisual ? metricInk : {})}
      // Never wider than its cell: a value with no space to wrap at (a release name) breaks inside itself instead.
      style={{ gap: size === 'default' ? 0 : 2, minWidth: 0, maxWidth: '100%' }}
      accessibilityLabel={accessibilityLabel}
      {...(props.pending ? { 'aria-busy': true } : {})}
    >
      {props.showLabel ? (
        <HappierText {...metricInk} style={text.caption} numberOfLines={1}>
          {props.label}
        </HappierText>
      ) : null}
      <View
        {...metricInk}
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          columnGap: HAPPIER_DATA_METRICS.comparisonGapPx,
        }}
      >
        {props.pending ? (
          // A metric sizes to its figure, so the bar's room is a representative figure in the value's own type, undrawn.
          <View style={{ position: 'relative' }}>
            <HappierText style={{ ...valueStyle, opacity: 0 }} tabularNumbers>{PENDING_FIGURE}</HappierText>
            <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, flexDirection: 'row' }}>
              <HappierSkeletonTitle theme={props.theme} lineHeight={valueStyle.lineHeight ?? props.theme.typography.body.lineHeight} line="whole" />
            </View>
          </View>
        ) : props.children ?? (
          <HappierText
            testID={props.testID ? `${props.testID}-value` : undefined}
            style={valueStyle}
            tabularNumbers
            // A figure is never ellipsized ("1 h 54 …"): a long one wraps at its spaces in a narrow cell.
          >
            {shown}
          </HappierText>
        )}
        {inlineUnit ? (
          <HappierText
            style={size === 'hero' ? text.strong : text.caption}
            numberOfLines={1}
          >
            {props.unit}
          </HappierText>
        ) : null}
        {size === 'hero' && !props.pending ? comparison : null}
      </View>
      {size === 'hero' && props.pending ? comparison : null}
      {size === 'hero' && props.comparison && !props.pending ? (
        <HappierText {...metricInk} style={text.caption}>{props.comparison.label}</HappierText>
      ) : null}
      {size !== 'hero' ? comparison : null}
      {size === 'stat' && !props.comparison && props.comparisonRoom && !props.pending ? (
        <View
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          testID={props.testID ? `${props.testID}-comparison-room` : undefined}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            columnGap: HAPPIER_DATA_METRICS.comparisonGapPx,
            opacity: 0,
          }}
        >
          <HappierText style={text.captionStrong} tabularNumbers>
            {props.comparisonRoom.value}
          </HappierText>
          <HappierText style={text.caption}>{props.comparisonRoom.label}</HappierText>
        </View>
      ) : null}
      {props.pending && props.caption !== undefined ? (
        <HappierSkeletonTitle theme={props.theme} line="meta"
          lineHeight={(size === 'default' ? text.caption.lineHeight : text.body.lineHeight) ?? props.theme.typography.body.lineHeight} />
      ) : props.caption ? (
        // Under a glance figure the line is its context ("was 188 ms before the last deploy"): it reads at the
        // meta size, a step above the default node's micro caption.
        <HappierText {...metricInk} style={size === 'default' ? text.caption : { ...text.body, color: props.theme.colors.mutedText }} numberOfLines={2}>
          {props.caption}
        </HappierText>
      ) : null}
    </View>
  );
  return hasExactTooltip
    ? <ChartDatum testID={props.testID ? `${props.testID}-datum` : undefined}
      datum={{ label: props.label, value: spokenValue, accessibilityLabel,
        subtitle: [value, props.caption, props.comparison ? `${props.comparison.value} ${props.comparison.label}` : null].filter(Boolean).join(' · ') }}>
      {visual}
    </ChartDatum>
    : visual;
}
