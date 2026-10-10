import { StackedSeriesChart, type StackedSeriesChartProps } from './StackedSeriesChart.js';

/** Observed and projected values are caller-produced series, never a forecast recomputed by a chart. */
export type BurnUpChartProps = Omit<StackedSeriesChartProps, 'variant' | 'normalized'>;
export function BurnUpChart(props: BurnUpChartProps) {
  return <StackedSeriesChart {...props} variant="line" />;
}
