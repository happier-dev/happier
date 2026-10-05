import { useState } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import {
  formatHappierDataShare,
  formatHappierDataValue,
  resolveHappierDataShares,
  estimateHappierDataColumnWidths,
  resolveHappierDataTableColumns,
  type HappierDataColumn,
  type HappierDataValue,
} from './dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles, type HappierDataTextStyles } from './dataText.js';

export type HappierDataRowsProps = Readonly<{
  /** The collection's name, for assistive technology; the frame's title names it on screen. */
  label?: string;
  columns: readonly HappierDataColumn[];
  /** Every row the source returned, cells in column order. Nothing is cut to fit the card. */
  rows: readonly (readonly HappierDataValue[])[];
  /** One admitted boolean status per row; its label carries the meaning beyond color. */
  marks?: readonly Readonly<{ passed: boolean; label: string; meaning: 'good' | 'bad' | 'neutral' }>[];
  /**
   * The source said more rows exist than it returned. Pass the sentence that says so ("More in the
   * full view"); it is drawn under the last row.
   */
  incomplete?: string;
  theme: HappierUiTheme;
  testID?: string;
}>;

function RowMark(props: Readonly<{ mark: NonNullable<HappierDataRowsProps['marks']>[number]; theme: HappierUiTheme;
  styles: HappierDataTextStyles; testID?: string }>) {
  const color = props.mark.meaning === 'good' ? props.theme.colors.success
    : props.mark.meaning === 'bad' ? props.theme.colors.danger : props.theme.colors.secondaryText;
  return <View accessibilityElementsHidden importantForAccessibility="no">
    <HappierText testID={props.testID} style={{ ...props.styles.strong, color }}>{props.mark.passed ? '✓' : '✗'}</HappierText>
  </View>;
}

function readable(column: HappierDataColumn, value: HappierDataValue | undefined, locale: string | undefined): string {
  return `${column.label}: ${value === undefined ? '' : formatHappierDataValue(value, locale)}`;
}

function IncompleteLine(props: Readonly<{ text: string; styles: HappierDataTextStyles; testID?: string }>) {
  return (
    <HappierText testID={props.testID ? `${props.testID}-incomplete` : undefined} style={{ ...props.styles.caption, paddingTop: HAPPIER_DATA_METRICS.cellPaddingVerticalPx }}>
      {props.text}
    </HappierText>
  );
}

/**
 * Rows (lab DP "Rows"): a list with one title per row. A proportion column becomes a funnel step —
 * the value, its share of the largest step and a bar; other columns join the row's quiet second line
 * ("Passed · 3m 12s").
 */
export function HappierDataRows(props: HappierDataRowsProps) {
  const text = useHappierDataTextStyles(props.theme);
  const proportionIndex = props.columns.findIndex((column) => column.proportion === true);
  const shares = proportionIndex < 0 ? [] : resolveHappierDataShares(props.rows.map((row) => {
    const value = row[proportionIndex];
    return typeof value === 'number' ? value : 0;
  }));
  return (
    <View testID={props.testID} role="list" accessibilityLabel={props.label} style={{ gap: HAPPIER_DATA_METRICS.rowGapPx }}>
      {props.rows.map((row, rowIndex) => {
        const mark = props.marks?.[rowIndex];
        const title = row[0] === undefined ? '' : formatHappierDataValue(row[0], text.locale);
        const lineCells = props.columns
          .map((column, index) => ({ column, index }))
          .filter(({ index }) => index > 0 && index !== proportionIndex);
        const line = lineCells.map(({ index }) => row[index]).filter((value) => value !== undefined)
          .map((value) => formatHappierDataValue(value!, text.locale)).join(' · ');
        const share = proportionIndex < 0 ? null : shares[rowIndex] ?? 0;
        const amount = proportionIndex < 0 ? null : row[proportionIndex];
        return (
          <View
            key={rowIndex}
            role="listitem"
            accessible
            accessibilityLabel={[title, ...(mark ? [mark.label] : []), ...props.columns.slice(1).map((column, index) => readable(column, row[index + 1], text.locale)),
              ...(share === null ? [] : [formatHappierDataShare(share, text.locale)])].join(', ')}
            testID={props.testID ? `${props.testID}-row-${rowIndex}` : undefined}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', columnGap: HAPPIER_DATA_METRICS.columnGapPx }}>
              {mark ? <RowMark mark={mark} theme={props.theme} styles={text} testID={props.testID ? `${props.testID}-mark-${rowIndex}` : undefined} /> : null}
              <HappierText style={{ ...text.body, flexShrink: 1, flexGrow: 1 }} numberOfLines={1}>{title}</HappierText>
              {amount === null || amount === undefined ? null : (
                <HappierText style={text.strong} tabularNumbers>
                  {formatHappierDataValue(amount, text.locale)}
                  <HappierText style={text.caption} tabularNumbers>{` ${formatHappierDataShare(share ?? 0, text.locale)}`}</HappierText>
                </HappierText>
              )}
            </View>
            {line ? <HappierText style={text.caption} numberOfLines={1}>{line}</HappierText> : null}
            {share === null ? null : (
              <View
                testID={props.testID ? `${props.testID}-bar-${rowIndex}` : undefined}
                style={{ height: HAPPIER_DATA_METRICS.proportionHeightPx, borderRadius: HAPPIER_DATA_METRICS.proportionHeightPx / 2,
                  marginTop: HAPPIER_DATA_METRICS.axisGapPx, overflow: 'hidden' }}
              >
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: props.theme.colors.text,
                  opacity: HAPPIER_DATA_METRICS.trackOpacity }} />
                <View testID={props.testID ? `${props.testID}-fill-${rowIndex}` : undefined} style={{ position: 'absolute', top: 0, left: 0, bottom: 0,
                  width: `${share * 100}%` as const, borderRadius: HAPPIER_DATA_METRICS.proportionHeightPx / 2,
                  backgroundColor: props.theme.colors.text, opacity: HAPPIER_DATA_METRICS.proportionOpacity }} />
              </View>
            )}
          </View>
        );
      })}
      {props.incomplete ? <IncompleteLine text={props.incomplete} styles={text} testID={props.testID} /> : null}
    </View>
  );
}

/**
 * A table (lab DP/DPp "Newest people"): a header, a hairline under every row but the last, the first
 * column the name and the last one aligned to the end. A narrow card keeps the columns that fit,
 * dropping `secondary` ones first — a phone shows Person · Got to · Joined, never squeezed text. Each
 * row still reads every column to assistive technology, so nothing is lost by narrowing.
 */
export function HappierDataTable(props: HappierDataRowsProps) {
  const text = useHappierDataTextStyles(props.theme);
  const [width, setWidth] = useState<number | null>(null);
  const sizing = {
    columns: props.columns,
    rows: props.rows,
    characterWidth: (text.body.fontSize ?? props.theme.typography.body.fontSize) * HAPPIER_DATA_METRICS.averageCharacterEm,
    locale: text.locale,
  };
  const visible = resolveHappierDataTableColumns({ ...sizing, availableWidth: width, gap: HAPPIER_DATA_METRICS.columnGapPx });
  const widths = estimateHappierDataColumnWidths(sizing);
  const lastVisible = visible[visible.length - 1];
  // The name takes the remaining width; every other column keeps one width on every row so the
  // columns line up, and the last sits at the end, like the lab's "Joined".
  const cellStyle = (index: number, position: number) => (position === 0
    ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }
    : { flexGrow: 0, flexShrink: 1, width: widths[index]! });
  const align = (index: number, position: number) => (index === lastVisible && position > 0 ? { textAlign: 'right' as const } : {});
  const divider = { borderBottomWidth: 1, borderBottomColor: props.theme.colors.divider };
  return (
    <View
      testID={props.testID}
      role="table"
      accessibilityLabel={props.label}
      onLayout={(event: HappierLayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
    >
      <View role="row" style={{ flexDirection: 'row', columnGap: HAPPIER_DATA_METRICS.columnGapPx, paddingBottom: HAPPIER_DATA_METRICS.cellPaddingVerticalPx - 1, ...divider }}>
        {visible.map((index, position) => (
          <View key={index} role="columnheader" style={cellStyle(index, position)}>
            <HappierText testID={props.testID ? `${props.testID}-header-${index}` : undefined}
              style={{ ...text.header, ...align(index, position) }} numberOfLines={1}>
              {props.columns[index]!.label}
            </HappierText>
          </View>
        ))}
      </View>
      {props.rows.map((row, rowIndex) => (
        <View
          key={rowIndex}
          role="row"
          accessible
          accessibilityLabel={[...(props.marks?.[rowIndex] ? [props.marks[rowIndex]!.label] : []),
            ...props.columns.map((column, index) => readable(column, row[index], text.locale))].join(', ')}
          testID={props.testID ? `${props.testID}-row-${rowIndex}` : undefined}
          style={{ flexDirection: 'row', columnGap: HAPPIER_DATA_METRICS.columnGapPx, paddingVertical: HAPPIER_DATA_METRICS.cellPaddingVerticalPx,
            ...(rowIndex < props.rows.length - 1 ? divider : {}) }}
        >
          {visible.map((index, position) => {
            const value = row[index];
            return (
              <View key={index} role="cell" style={{ ...cellStyle(index, position),
                ...(position === 0 && props.marks?.[rowIndex] ? { flexDirection: 'row', alignItems: 'baseline', columnGap: HAPPIER_DATA_METRICS.columnGapPx } : {}) }}>
                {position === 0 && props.marks?.[rowIndex] ? <RowMark mark={props.marks[rowIndex]!} theme={props.theme}
                  styles={text} testID={props.testID ? `${props.testID}-mark-${rowIndex}` : undefined} /> : null}
                <HappierText style={{ ...(position === 0 ? text.body : { ...text.body, color: props.theme.colors.secondaryText }),
                  ...align(index, position), ...(position === 0 ? { flexShrink: 1 } : {}) }} numberOfLines={1} tabularNumbers={typeof value === 'number' || index === lastVisible}>
                  {value === undefined ? '' : formatHappierDataValue(value, text.locale)}
                </HappierText>
              </View>
            );
          })}
        </View>
      ))}
      {props.incomplete ? <IncompleteLine text={props.incomplete} styles={text} testID={props.testID} /> : null}
    </View>
  );
}
