import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import { useOptionalHappierUiTypography } from '../../environment/context.js';
import { formatHappierDataValue, type HappierDataValue } from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';

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
   * `hero` is the one number a widget is about (the period's total); `stat` is one of a row of
   * labelled facts; `default` keeps the original metric node.
   */
  size?: 'hero' | 'stat' | 'default';
  /** Draw the label above the number (several facts in one widget). */
  showLabel?: boolean;
  /** One quiet line under the number ("plans + pay-as-you-go"). */
  caption?: string;
  /** Visible ink only ("721M"); assistive technology keeps the exact value. */
  valueFormatter?: (value: number) => string;
  theme: HappierUiTheme;
  testID?: string;
}>;

/**
 * One number, its unit and one comparison (lab DP "Metric"). Tabular figures so a refreshed value
 * never jitters; the comparison is coloured by meaning, never by sign.
 */
export function HappierDataMetric(props: HappierDataMetricProps) {
  const text = useHappierDataTextStyles(props.theme);
  const typography = useOptionalHappierUiTypography();
  const exact = formatHappierDataValue(props.value, text.locale);
  const value =
    typeof props.value === 'number' &&
    Number.isFinite(props.value) &&
    props.valueFormatter
      ? props.valueFormatter(props.value)
      : exact;
  const size = props.size ?? 'default';
  const comparisonColor =
    props.comparison?.meaning === 'good'
      ? props.theme.colors.success
      : props.comparison?.meaning === 'bad'
        ? props.theme.colors.danger
        : props.theme.colors.secondaryText;
  const valueStyle =
    size === 'hero'
      ? {
          ...resolveHappierTextStepStyle(
            HAPPIER_DATA_METRICS.heroValue,
            typography,
          ),
          color: props.theme.colors.text,
        }
      : size === 'stat'
        ? {
            ...resolveHappierTextStepStyle(
              HAPPIER_DATA_METRICS.statValue,
              typography,
            ),
            color: props.theme.colors.text,
          }
        : text.metric;
  const inlineUnit = size !== 'default' && props.unit;
  const shown = props.unit && !inlineUnit ? `${value} ${props.unit}` : value;
  const comparison = props.comparison ? (
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
  return (
    <View
      testID={props.testID}
      accessible
      style={{ gap: size === 'default' ? 0 : 2, minWidth: 0 }}
      accessibilityLabel={[
        `${props.label}: ${props.unit ? `${exact} ${props.unit}` : exact}`,
        props.comparison
          ? `${props.comparison.value} ${props.comparison.label}`
          : null,
        props.caption ?? null,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      {props.showLabel ? (
        <HappierText style={text.caption} numberOfLines={1}>
          {props.label}
        </HappierText>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          columnGap: HAPPIER_DATA_METRICS.comparisonGapPx,
        }}
      >
        <HappierText
          testID={props.testID ? `${props.testID}-value` : undefined}
          style={valueStyle}
          tabularNumbers
          numberOfLines={1}
        >
          {shown}
        </HappierText>
        {inlineUnit ? (
          <HappierText
            style={size === 'hero' ? text.strong : text.caption}
            numberOfLines={1}
          >
            {props.unit}
          </HappierText>
        ) : null}
        {size === 'hero' ? comparison : null}
      </View>
      {size === 'hero' && props.comparison ? (
        <HappierText style={text.caption}>{props.comparison.label}</HappierText>
      ) : null}
      {size !== 'hero' ? comparison : null}
      {props.caption ? (
        <HappierText style={text.caption} numberOfLines={2}>
          {props.caption}
        </HappierText>
      ) : null}
    </View>
  );
}
