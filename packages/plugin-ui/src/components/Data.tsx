import type { ReactElement } from 'react';

import { HappierDataChart } from '../presentation/data/Chart.js';
import { HappierDataRows, HappierDataTable, type HappierDataRowsProps } from '../presentation/data/DataRows.js';
import type { HappierDataColumn, HappierDataPoint, HappierDataValue } from '../presentation/data/dataModel.js';
import { HappierDataMetric, type HappierDataMetricComparison } from '../presentation/data/Metric.js';
import { usePluginTheme } from './PluginUiProvider.js';

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
  return <HappierDataChart {...props} theme={usePluginTheme()} />;
}
