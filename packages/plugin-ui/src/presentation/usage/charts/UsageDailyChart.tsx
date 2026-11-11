import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useOptionalHappierUiLocalization } from '../../../environment/context.js';
import { ChartDatum } from '../../data/ChartDatum.js';
import { describeHappierSeriesBucket, formatHappierDataValue } from '../../data/dataModel.js';
import { StackedSeriesChart, type StackedSeriesChartProps } from '../../data/StackedSeriesChart.js';

export type UsageDailyChartProps = Readonly<{
  theme: StackedSeriesChartProps['theme'];
  chart: Omit<StackedSeriesChartProps, 'theme' | 'testID' | 'variant'>;
  gap: number;
  footer?: ReactNode;
  testID: string;
}>;

/** Daily's shared presentation; the host supplies admitted series, labels and controls. */
export function UsageDailyChart(props: UsageDailyChartProps) {
  const localization = useOptionalHappierUiLocalization();
  const valuesLabel = props.chart.valuesLabel ?? `${props.chart.label} · ${localization?.translate('happier.plugin-ui.state.details', 'Details') ?? 'Details'}`;
  // The host's scrub overlay already owns its pointer interaction. Other Daily hosts retain
  // pointer readings while the exact table is the one keyboard and assistive-technology path.
  const renderBucket: StackedSeriesChartProps['renderBucket'] = props.chart.renderBucket ?? ((bucket, visual) =>
    props.chart.renderPlotOverlay ? visual : <ChartDatum datum={{ label: props.chart.label, keyboard: false, value: describeHappierSeriesBucket(bucket, props.chart.unknownLabel ?? formatHappierDataValue(null, localization?.locale), {
      locale: localization?.locale, formatCoordinate: props.chart.coordinateFormatter, formatValue: props.chart.valueFormatter,
    }) }}>{visual}</ChartDatum>);
  return <View style={{ gap: props.gap }} testID={`${props.testID}.daily`}>
    <StackedSeriesChart {...props.chart} valuesLabel={valuesLabel} renderBucket={renderBucket} testID={`${props.testID}.chart`} theme={props.theme} variant="bar" />
    {props.footer}
  </View>;
}
