import { useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiPlatform } from '../../environment/context.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HappierScrollArea } from '../layout/Layout.js';
import type { HappierFocusable, HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';
import { formatHappierDataValue } from './dataModel.js';

export type HappierGridAxis = Readonly<{ id: string; label: string }>;
export type HappierGridCell = Readonly<{
  id: string; row: string; column: string; label: string; value: number | null;
  valueLabel?: string; color?: string; emphasized?: boolean;
}>;
export type HappierGridFrame = Readonly<{
  contentWidth: number; columnStride: number; axisHeight: number;
  renderContent: (visibleLeft: number) => ReactNode;
}>;
export type HeatmapProps = Readonly<{
  theme: HappierUiTheme; label: string; cells: readonly HappierGridCell[];
  rows: readonly HappierGridAxis[]; columns: readonly HappierGridAxis[];
  size?: 'inline' | 'tile' | 'full'; layout?: 'grid' | 'strip';
  /** Reading order follows the caller's semantic axes, independently of size. */
  order?: 'rows' | 'columns';
  unknownLabel?: string; annotation?: string; showReadout?: boolean;
  /** Decorative tessellations defer exact accessibility to their owner's legend. */
  decorative?: boolean;
  onSelect?: (cellId: string) => void;
  renderCell?: (cell: HappierGridCell, visual: ReactNode, select: () => void) => ReactNode;
  renderFrame?: (frame: HappierGridFrame) => ReactNode;
  testID?: string;
}>;

const AXIS_LABEL_BOX_PX = 80;
const AXIS_LABEL_MIN_GAP_PX = 4;
const MONTH_LABEL_FONT_SIZE_PX = 10;

/** Only geometry: callers own dates, accounting, labels and missing-data decisions. */
export function resolveFirstFullyVisibleColumn(visibleLeft: number, stride: number): number {
  return stride <= 0 || visibleLeft <= 0 ? 0 : Math.ceil(visibleLeft / stride);
}

/**
 * Which labelled columns of an axis keep their label. A label is one line centred on its column and may
 * overflow the slot, but never lands on its neighbour: when columns are closer than the labels are wide,
 * the axis thins to every n-th labelled column. An unknown stride (before layout) keeps every label.
 */
export function resolveVisibleAxisLabels(input: Readonly<{ labels: readonly string[]; stride: number; characterWidth: number }>): ReadonlySet<number> {
  const visible = new Set<number>();
  let previous: { index: number; width: number } | null = null;
  for (const [index, label] of input.labels.entries()) {
    if (!label) continue;
    const width = label.length * input.characterWidth;
    const clear = previous === null || input.stride <= 0
      || (index - previous.index) * input.stride >= (previous.width + width) / 2 + AXIS_LABEL_MIN_GAP_PX;
    if (clear) { visible.add(index); previous = { index, width }; }
  }
  return visible;
}

/**
 * Which labels of a contribution grid's month axis fit their own month. A label starts at its month's first
 * column and reads across that month's run of columns, up to the next month or the grid's end; a run too
 * short to hold it (the part-month at either end of a period) goes unlabelled, as on GitHub's calendar.
 */
export function resolveFittingRunLabels(input: Readonly<{ labels: readonly string[]; stride: number; characterWidth: number }>): ReadonlySet<number> {
  const fitting = new Set<number>();
  let runEnd = input.labels.length;
  for (let index = input.labels.length - 1; index >= 0; index -= 1) {
    const label = input.labels[index];
    if (!label) continue;
    if ((runEnd - index) * input.stride >= label.length * input.characterWidth + AXIS_LABEL_MIN_GAP_PX) fitting.add(index);
    runEnd = index;
  }
  return fitting;
}

export function Heatmap(props: HeatmapProps) {
  return <HappierDataGrid {...props} variant="heatmap" />;
}

/** One cell geometry and interaction owner for contribution, sample and dot grids. */
export function HappierDataGrid(props: HeatmapProps & { variant: 'heatmap' | 'dots'; dotAppearance?: 'dots' | 'cells' }) {
  const text = useHappierDataTextStyles(props.theme);
  const platform = useOptionalHappierUiPlatform()?.platform;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [axisWidth, setAxisWidth] = useState<number | null>(null);
  const controls = useRef(new Map<string, HappierFocusable>());
  const selected = props.cells.find((cell) => cell.id === selectedId);
  const unknown = props.unknownLabel ?? '—';
  const rawValue = (cell: HappierGridCell) => cell.value === null || !Number.isFinite(cell.value) ? unknown : formatHappierDataValue(cell.value, text.locale);
  const visibleValue = (cell: HappierGridCell) => cell.value === null || !Number.isFinite(cell.value) ? unknown : cell.valueLabel ?? rawValue(cell);
  const exact = (cell: HappierGridCell) => `${cell.label}: ${rawValue(cell)}${visibleValue(cell) !== rawValue(cell) ? ` (${visibleValue(cell)})` : ''}`;
  const select = (cell: HappierGridCell) => { setSelectedId(cell.id); props.onSelect?.(cell.id); };
  const strip = props.layout === 'strip';
  const dots = props.variant === 'dots';
  const circles = dots && props.dotAppearance === 'dots';
  const rowMajor = dots || strip || props.order === 'rows';
  // The row-label gutter fits its labels: one letter keeps the dense column, a short day name ("Mon")
  // gets room rather than wrapping under itself.
  const rowLabelWidth = props.rows.some((row) => row.label.length > 1) ? 28 : 16;
  // Incumbent contribution grid, recap tiles and dense dot matrix metrics.
  const cellSize = props.size === 'inline' ? 7.5 : props.size === 'tile' ? 16 : 11;
  const gap = strip ? 4 : props.size === 'tile' && !dots ? 7 : 3;
  // Every pointer keeps the drawn grid: a cell's touch target is its hit area, reaching half the gap to
  // its neighbours, never a larger slot or stride (DESIGN.md → touch targets are hit areas). The exact
  // values stay reachable through focus, the arrow keys and the readout.
  const slotSize = cellSize;
  const stride = slotSize + gap;
  const contentWidth = props.columns.length * stride;
  const rowGap = dots || strip ? 4 : gap;
  const cellHitReach = { top: rowGap / 2, bottom: rowGap / 2, left: gap / 2, right: gap / 2 };
  // A full fixed-cell grid on a native screen scrolls sideways itself when the caller supplies no frame.
  const ownsOverflow = (platform === 'ios' || platform === 'android') && !strip && !dots && !props.renderCell && !props.decorative;
  const positions = new Map(props.cells.map((cell) => [`${cell.row}\u0000${cell.column}`, cell]));
  const maximum = Math.max(1, ...props.cells.map((cell) => cell.value !== null && Number.isFinite(cell.value) ? cell.value : 0));
  const renderCell = (row: HappierGridAxis, column: HappierGridAxis) => {
    const cell = positions.get(`${row.id}\u0000${column.id}`);
    const flexible = strip || dots;
    const slot = flexible ? { flex: 1, minWidth: 0 } : { width: cellSize, height: cellSize };
    if (!cell) return <View key={`${row.id}:${column.id}`} style={slot} />;
    const missing = cell.value === null || !Number.isFinite(cell.value);
    const share = missing ? 0 : Math.max(0, cell.value ?? 0) / maximum;
    // screens-kit.js punch('dot'): r=.9 at zero, otherwise 1.3+4.4*share in a 12.4-wide slot.
    const diameterPercent = (missing || share === 0 ? 1.8 : 2.6 + 8.8 * share) / 12.4 * 100;
    const mark = <View style={{ width: circles ? `${diameterPercent}%` : '100%', ...(strip ? { height: props.columns.length > 14 ? 16 : 28 } : dots ? { aspectRatio: 1 } : { height: cellSize }),
      borderRadius: circles ? 999 : strip || props.size === 'tile' ? 4 : dots ? 2 : 2.5,
      backgroundColor: cell.color ?? (missing || cell.value === 0 ? props.theme.colors.surface : props.theme.colors.info),
      opacity: circles || cell.color || missing || cell.value === 0 ? 1 : 0.16 + 0.84 * share,
      borderWidth: cell.emphasized || missing ? 1 : 0, borderColor: cell.emphasized ? props.theme.colors.info : props.theme.colors.divider }} />;
    const visual = circles ? <View style={{ width: '100%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}>{mark}</View> : mark;
    if (props.decorative) return <View key={cell.id} style={slot}>{visual}</View>;
    if (props.renderCell) return <View key={cell.id} style={slot}>{props.renderCell(cell, visual, () => select(cell))}</View>;
    return <HappierPressable key={cell.id} testID={props.testID ? `${props.testID}-cell-${cell.id}` : undefined}
      accessibilityLabel={exact(cell)} selected={selectedId === cell.id} style={slot} hitReach={cellHitReach}
      controlRef={(control) => { if (control) controls.current.set(cell.id, control); else controls.current.delete(cell.id); }}
      onPress={() => select(cell)} onFocusChange={(focused) => { if (focused) select(cell); }}
      onKeyDown={(key) => {
        const rowIndex = props.rows.findIndex((entry) => entry.id === cell.row);
        const columnIndex = props.columns.findIndex((entry) => entry.id === cell.column);
        const nextRow = key === 'ArrowDown' ? rowIndex + 1 : key === 'ArrowUp' ? rowIndex - 1 : rowIndex;
        const nextColumn = key === 'ArrowRight' ? columnIndex + 1 : key === 'ArrowLeft' ? columnIndex - 1 : key === 'Home' ? 0 : key === 'End' ? props.columns.length - 1 : columnIndex;
        if (nextRow === rowIndex && nextColumn === columnIndex) return false;
        const target = positions.get(`${props.rows[nextRow]?.id}\u0000${props.columns[nextColumn]?.id}`);
        if (target) { select(target); controls.current.get(target.id)?.focus(); }
        return true;
      }}>{visual}</HappierPressable>;
  };
  // Axis labels sit centred on their column on one line; a narrow axis thins them rather than wrapping.
  const axisStride = axisWidth !== null && props.columns.length > 0 ? (axisWidth + gap) / props.columns.length : 0;
  const visibleAxisLabels = resolveVisibleAxisLabels({ labels: props.columns.map((column) => column.label), stride: axisStride,
    characterWidth: 11 * HAPPIER_DATA_METRICS.averageCharacterEm });
  const monthLabels = resolveFittingRunLabels({ labels: props.columns.map((column) => column.label), stride,
    characterWidth: MONTH_LABEL_FONT_SIZE_PX * HAPPIER_DATA_METRICS.averageCharacterEm });
  const content = (visibleLeft: number) => <View style={{ gap: dots || strip ? 4 : rowMajor ? gap : 8 }}>
    {!dots && !strip && props.columns.some((column) => column.label) ? <View style={{ height: 14, flexDirection: 'row', gap }}>
      {props.columns.map((column, index) => <View key={column.id} style={{ width: slotSize, position: 'relative' }}>
        {index >= resolveFirstFullyVisibleColumn(visibleLeft, stride) && monthLabels.has(index) ? <HappierText style={{ ...text.caption, position: 'absolute', fontSize: MONTH_LABEL_FONT_SIZE_PX, lineHeight: 12 }}>{column.label}</HappierText> : null}
      </View>)}
    </View> : null}
    {rowMajor ? props.rows.map((row) => <View key={row.id} style={{ flexDirection: 'row', gap: dots ? 8 : 0, alignItems: 'center' }}>
      {dots ? <HappierText style={{ ...text.caption, width: rowLabelWidth, fontSize: 11, lineHeight: 14 }} numberOfLines={1}>{row.label}</HappierText> : null}
      <View style={{ flex: dots || strip ? 1 : undefined, flexDirection: 'row', gap }}>{props.columns.map((column) => renderCell(row, column))}</View>
    </View>) : <View style={{ flexDirection: 'row', gap }}>{props.columns.map((column) => <View key={column.id} style={{ gap }}>{props.rows.map((row) => renderCell(row, column))}</View>)}</View>}
    {(dots || strip) && props.columns.some((column) => column.label) ? <View style={{ flexDirection: 'row', gap: dots ? 8 : 0 }}>
      {dots ? <View style={{ width: rowLabelWidth }} /> : null}
      <View style={{ flex: 1, flexDirection: 'row', gap }}
        onLayout={(event: HappierLayoutChangeEvent) => setAxisWidth(event.nativeEvent.layout.width)}>
        {props.columns.map((column, index) => <View key={column.id} testID={props.testID ? `${props.testID}-axis-${column.id}` : undefined}
          style={{ flex: 1, minWidth: 0, height: 14 }}>
          {column.label && visibleAxisLabels.has(index) ? <View pointerEvents="none"
            style={{ position: 'absolute', left: '50%', width: AXIS_LABEL_BOX_PX, marginLeft: -AXIS_LABEL_BOX_PX / 2, alignItems: 'center' }}>
            <HappierText numberOfLines={1} style={{ ...text.caption, fontSize: 11, lineHeight: 14, textAlign: 'center' }}>{column.label}</HappierText>
          </View> : null}
        </View>)}
      </View>
    </View> : null}
  </View>;
  return <View testID={props.testID} accessibilityLabel={props.decorative ? undefined : props.label} aria-hidden={props.decorative} importantForAccessibility={props.decorative ? 'no-hide-descendants' : 'auto'}>
    {props.annotation ? <HappierText style={text.caption}>{props.annotation}</HappierText> : null}
    {props.renderFrame ? props.renderFrame({ contentWidth, columnStride: stride, axisHeight: 22, renderContent: content })
      : ownsOverflow ? <HappierScrollArea horizontal accessibilityLabel={props.label} style={{ maxWidth: '100%' }}>{content(0)}</HappierScrollArea> : content(0)}
    {!props.decorative && selected && (props.showReadout ?? true) ? <View testID={props.testID ? `${props.testID}-readout` : undefined} accessibilityLiveRegion="polite"><HappierText style={text.caption} tabularNumbers>{`${selected.label}: ${visibleValue(selected)}`}</HappierText></View> : null}
  </View>;
}
