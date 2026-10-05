import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { HappierText } from '../text/Text.js';
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
  /** What the number counts; read to assistive technology, the frame's title names it on screen. */
  label: string;
  value: HappierDataValue;
  unit?: string;
  comparison?: HappierDataMetricComparison;
  theme: HappierUiTheme;
  testID?: string;
}>;

/**
 * One number, its unit and one comparison (lab DP "Metric"). Tabular figures so a refreshed value
 * never jitters; the comparison is coloured by meaning, never by sign.
 */
export function HappierDataMetric(props: HappierDataMetricProps) {
  const text = useHappierDataTextStyles(props.theme);
  const value = formatHappierDataValue(props.value, text.locale);
  const shown = props.unit ? `${value} ${props.unit}` : value;
  const comparisonColor = props.comparison?.meaning === 'good'
    ? props.theme.colors.success
    : props.comparison?.meaning === 'bad' ? props.theme.colors.danger : props.theme.colors.secondaryText;
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={[`${props.label}: ${shown}`, props.comparison ? `${props.comparison.value} ${props.comparison.label}` : null]
        .filter(Boolean).join(', ')}
    >
      <HappierText testID={props.testID ? `${props.testID}-value` : undefined} style={text.metric} tabularNumbers numberOfLines={1}>
        {shown}
      </HappierText>
      {props.comparison ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: HAPPIER_DATA_METRICS.comparisonGapPx }}>
          <HappierText style={{ ...text.captionStrong, color: comparisonColor }} tabularNumbers>
            {props.comparison.value}
          </HappierText>
          <HappierText style={text.caption}>{props.comparison.label}</HappierText>
        </View>
      ) : null}
    </View>
  );
}
