import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { packWidgetGroupBands, type WidgetGroupBand } from '@happier-dev/plugin-ui/presentation';

import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { useDeviceType } from '@/utils/platform/responsive';

import { CARD_GRID, resolveCardGridColumns } from './cardGridMetrics';

/**
 * A card that takes more than one column: `2`, or the whole `row` (it falls back to the columns
 * there are, so on a phone every card is one column). Plain children take one column each.
 * `rows` is its height in grid rows (a widget footprint's `rowSpan`): see `CardGrid`.
 * `columns` gives a mixed row its capacity; `startRow` keeps its boundary when fewer columns fit.
 */
export function CardGridCell(props: Readonly<{ span?: 2 | 'row'; rows?: number; columns?: 1 | 2 | 3; startRow?: boolean; children: React.ReactNode }>) {
    return <>{props.children}</>;
}

type CardGridEntry = Readonly<{ id: string; span: 2 | 'row' | undefined; rows: number | undefined; columns: 1 | 2 | 3 | undefined; startRow: boolean; node: React.ReactNode }>;

/**
 * The card grid: the shared column owner (`ItemGroupColumns`) at the card rhythm (`CARD_GRID`). Each
 * child is one card; cards in a row share its height. It measures its own width (never the window) and passes
 * the resolved count down, so the count has one owner, and reports it for callers that lay things
 * over the grid (the set-up block morph).
 */
export const CardGrid = React.memo(function CardGrid(props: Readonly<{
    children: React.ReactNode;
    /** At most this many columns (default three). */
    columns?: 1 | 2 | 3;
    onColumnCountChange?: (columns: number) => void;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>) {
    const requested = props.columns ?? CARD_GRID.columns;
    const [columns, setColumns] = React.useState(1);
    const onColumnCountChange = props.onColumnCountChange;
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (!Number.isFinite(width) || width <= 0) return;
        const next = resolveCardGridColumns(width, requested);
        setColumns((current) => (current === next ? current : next));
    }, [requested]);
    React.useEffect(() => { onColumnCountChange?.(columns); }, [columns, onColumnCountChange]);

    // Cards that say how many rows they take (widget footprints) pack in two dimensions on a two-column grid,
    // with the widget groups' packer: each half card takes the shorter column, so two Smalls stack beside a
    // Medium (lab widget-groups wgvar). The packing follows the device, never the measured width, so no card
    // remounts when the first measure lands; a pane too narrow for two columns stacks a band's columns.
    const phone = useDeviceType() === 'phone';
    const entries: CardGridEntry[] = [];
    React.Children.forEach(props.children, (child) => {
        if (child == null || child === false) return;
        const cell = React.isValidElement<React.ComponentProps<typeof CardGridCell>>(child) && child.type === CardGridCell
            ? child.props : undefined;
        const key = React.isValidElement(child) && child.key != null ? String(child.key) : String(entries.length);
        entries.push({ id: key, span: cell?.span, rows: cell?.rows, columns: cell?.columns, startRow: cell?.startRow === true, node: child });
    });
    const twoDimensional = requested === 2 && !phone && entries.some((entry) => entry.rows !== undefined);

    if (twoDimensional) {
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        // `customize` keeps a lone half card at its half; the grid never stretches a card wider than its size.
        const bands = packWidgetGroupBands(entries.map((entry) => ({ id: entry.id, columnSpan: entry.span ? 2 : 1, rowSpan: entry.rows ?? 1 })), 2, 'customize');
        return (
            <View testID={props.testID} style={[bandListStyle, props.style]} onLayout={onLayout}>
                {bands.map((band) => <CardGridBand key={band.key} band={band} byId={byId} stacked={columns < 2} testID={props.testID} />)}
            </View>
        );
    }

    // Mixed row capacities keep every card under one keyed parent. Finish a partial row before the
    // next capacity starts (a trio collapsed to two columns must not borrow the following pair).
    const cells: React.ReactNode[] = [];
    let previousCapacity = requested;
    let used = 0;
    for (const entry of entries) {
        const capacity = entry.columns ?? requested;
        if ((entry.startRow || capacity !== previousCapacity) && used > 0) {
            const remaining = Math.min(previousCapacity, columns) - used;
            cells.push(<ItemGroupColumn key={`gap:${entry.id}`} columns={previousCapacity} span={remaining === 2 ? 2 : 1}>{null}</ItemGroupColumn>);
            used = 0;
        }
        const count = Math.min(capacity, columns);
        const span = entry.span === 'row' ? capacity : entry.span;
        cells.push(<ItemGroupColumn key={`card:${entry.id}`} columns={capacity} span={span} style={cellStyle}>{entry.node}</ItemGroupColumn>);
        const occupied = Math.min(span ?? 1, count);
        used = ((used + occupied > count ? 0 : used) + occupied) % count;
        previousCapacity = capacity;
    }
    return (
        <View testID={props.testID} style={props.style} onLayout={onLayout}>
            <ItemGroupColumns
                activeColumns={columns}
                paddingHorizontal={0}
                paddingVertical={0}
                columnGap={CARD_GRID.gapPx}
                rowGap={CARD_GRID.gapPx}
            >
                {cells}
            </ItemGroupColumns>
        </View>
    );
});

/**
 * One band: a full-width card, or two columns. The column holding the band's rows shares its height among its
 * cards in proportion to their rows; a column with fewer rows keeps each card at its own height and leaves quiet
 * paper under it (lab widget-groups), so a Small never stretches to a Medium's height.
 */
function CardGridBand(props: Readonly<{ band: WidgetGroupBand; byId: ReadonlyMap<string, CardGridEntry>; stacked: boolean; testID?: string }>) {
    const { band } = props;
    if (band.kind === 'slot') return null;
    if (band.kind === 'row') return <View style={rowBandStyle}>{props.byId.get(band.cell.id)?.node}</View>;
    const rows = band.columns.map((column) => column.reduce((total, cell) => total + cell.rowSpan, 0));
    const bandRows = Math.max(...rows);
    return (
        <View testID={props.testID ? `${props.testID}.band.${band.key}` : undefined} style={props.stacked ? stackedBandStyle : columnsBandStyle}>
            {band.columns.map((column, index) => (
                <View key={index} testID={props.testID ? `${props.testID}.band.${band.key}.column.${index}` : undefined}
                    style={props.stacked ? stackedColumnStyle : bandColumnStyle}>
                    {column.map((cell) => (
                        <View key={cell.id} style={{ flexGrow: props.stacked || rows[index] === bandRows ? cell.rowSpan : 0 }}>
                            {props.byId.get(cell.id)?.node}
                        </View>
                    ))}
                </View>
            ))}
        </View>
    );
}

// A card fills its cell, so every card in a row is as tall as the tallest. Grow from the card's own
// height, never `flex: 1`: native Yoga gives that a zero basis, so a height-bounded host (a sheet)
// shrinks every card to nothing and the rows draw stacked over each other.
const cellStyle: ViewStyle = { flexGrow: 1 };
const bandListStyle: ViewStyle = { rowGap: CARD_GRID.gapPx };
const rowBandStyle: ViewStyle = { flexDirection: 'column' };
const columnsBandStyle: ViewStyle = { flexDirection: 'row', columnGap: CARD_GRID.gapPx };
const stackedBandStyle: ViewStyle = { flexDirection: 'column', rowGap: CARD_GRID.gapPx };
const bandColumnStyle: ViewStyle = { flex: 1, minWidth: 0, rowGap: CARD_GRID.gapPx };
const stackedColumnStyle: ViewStyle = { rowGap: CARD_GRID.gapPx };
