import { View } from 'react-native';
import type { ReactNode } from 'react';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierDataRows, type HappierDataRowsProps } from './DataRows.js';
import { useHappierDataTextStyles } from './dataText.js';
import { HappierText } from '../text/Text.js';

export type RankedRowsProps = Readonly<{
  theme: HappierUiTheme; label: string;
  rows: readonly Readonly<{ id: string; label: string; value: number | null; color?: string; annotation?: string }>[];
  basis?: string; unknownLabel?: string; size?: 'inline' | 'tile' | 'full'; testID?: string;
  barAppearance?: HappierDataRowsProps['proportionAppearance'];
  renderRow?: (row: RankedRowsProps['rows'][number], visual: ReactNode) => ReactNode;
  /** Visible amount ink ("317M"); exact values stay in each row's accessible label. */
  valueFormatter?: (value: number) => string;
  /** The supplied whole; each known row then shows its share of it. Never inferred from the rows. */
  total?: number | null;
  /** Leading identity marks by row id (an agent or machine glyph). */
  leads?: Readonly<Record<string, ReactNode>>;
  /** Further identity marks by row id, drawn straight after the row's title. */
  trails?: Readonly<Record<string, ReactNode>>;
}>;

/** Source-ordered rows: the caller owns ranking, units and any aggregation. */
export function RankedRows(props: RankedRowsProps) {
  const text = useHappierDataTextStyles(props.theme);
  return <View accessibilityLabel={[props.label, props.basis].filter(Boolean).join(', ')}>
    {props.basis ? <HappierText style={text.caption}>{props.basis}</HappierText> : null}
    <HappierDataRows theme={props.theme} label={props.label} testID={props.testID}
      rowIds={props.rows.map(row => row.id)} proportionColors={props.rows.map(row => row.color ?? props.theme.colors.accent)} showProportionShares={false}
      proportionAppearance={props.barAppearance} valueFormatter={props.valueFormatter}
      rowLeads={props.leads ? props.rows.map(row => props.leads![row.id]) : undefined}
      rowTrails={props.trails ? props.rows.map(row => props.trails![row.id]) : undefined}
      rowShares={props.total !== undefined && props.total !== null && Number.isFinite(props.total) && props.total > 0
        ? props.rows.map(row => row.value !== null && Number.isFinite(row.value) && row.value >= 0 ? row.value / props.total! : null) : undefined}
      density={props.size === 'inline' || props.size === 'tile' ? 'compact' : 'comfortable'}
      renderRow={props.renderRow ? (_row, visual, index) => props.renderRow!(props.rows[index]!, visual) : undefined}
      columns={[{ label: props.label }, { label: props.basis ?? props.label, proportion: true }, { label: 'Annotation' }]}
      rows={props.rows.map(row => [row.label, row.value !== null && Number.isFinite(row.value) ? row.value : props.unknownLabel ?? 'Unknown',
        row.annotation ?? ''])} />
  </View>;
}
