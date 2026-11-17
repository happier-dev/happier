import type { ReactElement } from 'react';
import { View } from 'react-native';

/** Page rows keep their keyed cells when a details pane changes the column count. */
export function CatalogDirectory(props: Readonly<{
  rows: readonly ReactElement[];
  columns: number;
  columnGapPx: number;
  rowGapPx?: number;
  lineTestID?: string;
  /** A windowed line holds some of a section's rows: its own count says nothing about whether the section is a lone row. */
  spanLoneRow?: boolean;
}>): ReactElement {
  // A lone row spans the line: half a line beside empty space truncates it for nothing (TASTE-S4060 D5).
  const columns = props.rows.length > 1 || props.spanLoneRow === false ? Math.max(1, props.columns) : 1;
  const halfGap = columns > 1 ? props.columnGapPx / 2 : 0;
  const cellStyle = { width: `${100 / columns}%`, minWidth: 0, paddingHorizontal: halfGap } as const;
  return (
    <View testID={columns > 1 ? props.lineTestID : undefined}
      style={[WRAP_STYLE, { marginHorizontal: -halfGap, rowGap: props.rowGapPx ?? 0 }]}>
      {props.rows.map((row, index) => <View key={row.key ?? index} style={cellStyle}>{row}</View>)}
    </View>
  );
}

const WRAP_STYLE = { flexDirection: 'row', flexWrap: 'wrap' } as const;
