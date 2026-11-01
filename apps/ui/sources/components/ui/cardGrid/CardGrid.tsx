import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';

import { CARD_GRID, resolveCardGridColumns } from './cardGridMetrics';

/**
 * A card that takes more than one column: `2`, or the whole `row` (it falls back to the columns
 * there are, so on a phone every card is one column). Plain children take one column each.
 * `columns` gives a mixed row its capacity; `startRow` keeps its boundary when fewer columns fit.
 */
export function CardGridCell(props: Readonly<{ span?: 2 | 'row'; columns?: 1 | 2 | 3; startRow?: boolean; children: React.ReactNode }>) {
    return <>{props.children}</>;
}

type CardGridEntry = Readonly<{ id: string; span: 2 | 'row' | undefined; columns: 1 | 2 | 3 | undefined; startRow: boolean; node: React.ReactNode }>;

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

    const entries: CardGridEntry[] = [];
    React.Children.forEach(props.children, (child) => {
        if (child == null || child === false) return;
        const cell = React.isValidElement<React.ComponentProps<typeof CardGridCell>>(child) && child.type === CardGridCell
            ? child.props : undefined;
        const key = React.isValidElement(child) && child.key != null ? String(child.key) : String(entries.length);
        entries.push({ id: key, span: cell?.span, columns: cell?.columns, startRow: cell?.startRow === true, node: child });
    });
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

const cellStyle: ViewStyle = { flex: 1 };
const bandListStyle: ViewStyle = { rowGap: CARD_GRID.gapPx };
const rowBandStyle: ViewStyle = { flexDirection: 'column' };
const columnsBandStyle: ViewStyle = { flexDirection: 'row', columnGap: CARD_GRID.gapPx };
const stackedBandStyle: ViewStyle = { flexDirection: 'column', rowGap: CARD_GRID.gapPx };
const bandColumnStyle: ViewStyle = { flex: 1, minWidth: 0, rowGap: CARD_GRID.gapPx };
const stackedColumnStyle: ViewStyle = { rowGap: CARD_GRID.gapPx };
