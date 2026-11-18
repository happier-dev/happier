import type { ReactElement } from 'react';

import { HappierDataChart } from '../presentation/data/Chart.js';
import { HappierDataRows, HappierDataTable, type HappierDataRowsProps } from '../presentation/data/DataRows.js';
import { resolveHappierSeriesAreaWash, type HappierDataColumn, type HappierDataPoint, type HappierDataValue } from '../presentation/data/dataModel.js';
import { useHappierUiPlatform } from '../environment/context.js';
import { HappierDataMetric, type HappierDataMetricComparison } from '../presentation/data/Metric.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { useWidgetPresentation } from './WidgetPresentation.js';

/**
 * The native data nodes for executable plugin surfaces: the very components Happier's own widgets
 * and declarative documents draw (lab `dashboards` DP). This adapter supplies only the plugin theme.
 */

export type MetricProps = Readonly<{
  /** What the number counts, read to assistive technology. */
  label: string;
  value: HappierDataValue;
  unit?: string;
  comparison?: HappierDataMetricComparison;
  /** `stat` for one of a row of labelled facts; `default` for a metric that stands alone. */
  size?: 'stat' | 'default';
  /** Draw the label above the number, where several facts stand in one row (a database's Size, Connections). */
  showLabel?: boolean;
  /** Visible contextual line under the number, rendered by the shared metric. */
  caption?: string;
  testID?: string;
}>;

export function Metric(props: MetricProps): ReactElement {
  return <HappierDataMetric {...props} theme={usePluginTheme()} />;
}

export type DataRowsProps = Readonly<{
  label?: string;
  columns: readonly HappierDataColumn[];
  /** Every row; nothing is cut to fit the card. */
  rows: readonly (readonly HappierDataValue[])[];
  marks?: HappierDataRowsProps['marks'];
  /** When the source has more rows than it returned, the sentence that says so. */
  incomplete?: string;
  testID?: string;
}>;

/** List rows, with a proportion column drawn as a funnel step. */
export function DataRows(props: DataRowsProps): ReactElement {
  return <HappierDataRows {...props} theme={usePluginTheme()} />;
}

/** A table that keeps the columns that fit, dropping `secondary` ones first. */
export function DataTable(props: DataRowsProps): ReactElement {
  return <HappierDataTable {...props} theme={usePluginTheme()} />;
}

export type ChartProps = Readonly<{
  label: string;
  style: 'bar' | 'line';
  points: readonly HappierDataPoint[];
  testID?: string;
}>;

/** One series: bars for counts per period, a line for a rate. */
export function Chart(props: ChartProps): ReactElement {
  const presentation = useWidgetPresentation();
  return <HappierDataChart {...props} theme={usePluginTheme()} viewportHeight={presentation?.geometry?.height} />;
}

/** The wash under a history line in the host's colour scheme, for `HappierSeries.fillOpacity`. */
export function useSeriesAreaWash(): number {
  return resolveHappierSeriesAreaWash(useHappierUiPlatform().colorScheme);
}
