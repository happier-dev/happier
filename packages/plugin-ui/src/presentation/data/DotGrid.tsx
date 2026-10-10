import { HappierDataGrid, type HeatmapProps } from './Heatmap.js';

export type DotGridProps = Omit<HeatmapProps, 'layout' | 'renderFrame'> & Readonly<{
  /** The kit's radius-scaled dots, or the incumbent dense square cells. */
  appearance?: 'dots' | 'cells';
}>;

/** A weekday/hour or unrelated row/column matrix; cells are already positioned. */
export function DotGrid(props: DotGridProps) {
  return <HappierDataGrid {...props} variant="dots" dotAppearance={props.appearance ?? 'dots'} />;
}
