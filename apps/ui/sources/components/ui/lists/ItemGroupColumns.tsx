import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    ITEM_GROUP_COLUMN_GAP_PX,
    resolveItemGroupColumnCountForWidth,
} from './itemGroupColumnLayout';

type ItemGroupColumnsContextValue = Readonly<{
    activeColumns: number;
}>;

const ItemGroupColumnsContext = React.createContext<ItemGroupColumnsContextValue>({ activeColumns: 1 });

export type ItemGroupColumnsProps = Readonly<{
    children: React.ReactNode;
    columns?: 1 | 2 | 3 | 4;
    /**
     * Explicit resolved column count, for a caller that ALREADY measures.
     *
     * `ItemGroup` resolves the count itself because it must know it before
     * rendering — the count decides each row's cell width and whether the rows
     * share a card or become standalone ones. Passing it here keeps the layout
     * and that decision from ever disagreeing, and suppresses this component's
     * own measurement so the number has exactly one owner.
     */
    activeColumns?: number;
    /**
     * Narrowest a cell may become before a column is given up, in px.
     *
     * Defaults to the list-row floor. A grid of compact cards — a metric tile, a
     * usage meter — genuinely reads fine much narrower than a title+subtitle
     * list row, and says so here rather than inheriting a floor sized for text.
     */
    minColumnWidthPx?: number;
    style?: StyleProp<ViewStyle>;
    paddingHorizontal?: number;
    paddingVertical?: number;
    columnGap?: number;
    rowGap?: number;
}>;

export type ItemGroupColumnProps = Readonly<{
    children: React.ReactNode;
    span?: 1 | 2 | 3 | 4;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create(() => ({
    container: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
    },
    column: {
        minWidth: 0,
    },
    fullWidthColumn: {
        width: '100%',
        flexBasis: '100%',
    },
    flexibleColumn: {
        flexBasis: 0,
        flexShrink: 1,
    },
}));

/**
 * A wrapping grid whose column count comes from ONE input: the width this
 * container actually got.
 *
 * Not the window. A grid is routinely a `flex: 1` pane beside a fixed rail — a
 * settings pane, a docked column — where the window width says nothing about the
 * room a cell gets, and a device-class rule reads a narrow pane in a wide window
 * exactly backwards. `ItemGroup` resolves the same rule off its own box for the
 * same reason.
 *
 * The COUNT is the state, never the width. A web ResizeObserver reports a fresh
 * width for every sub-pixel reflow; holding the raw number would re-render every
 * cell for an identical layout. The width lives in a ref because nothing renders
 * it — it is only ever this resolver's input.
 */
export const ItemGroupColumns = React.memo<ItemGroupColumnsProps>((props) => {
    const styles = stylesheet;
    const { activeColumns: explicitColumns, minColumnWidthPx } = props;
    const requestedColumns = props.columns ?? 2;
    const paddingHorizontal = props.paddingHorizontal ?? 16;
    const columnGap = props.columnGap ?? ITEM_GROUP_COLUMN_GAP_PX;

    const measuredContentWidthRef = React.useRef<number | undefined>(undefined);
    const [measuredColumns, setMeasuredColumns] = React.useState(1);

    const resolveColumnCountForContentWidth = React.useCallback((contentWidthPx: number | undefined): number => {
        if (contentWidthPx === undefined) return 1;
        return resolveItemGroupColumnCountForWidth({
            availableWidthPx: contentWidthPx,
            requestedColumns,
            minColumnWidthPx,
            columnGapPx: columnGap,
        });
    }, [columnGap, minColumnWidthPx, requestedColumns]);

    // Holding the count rather than the width would otherwise strand a stale
    // count whenever the resolver's OWN inputs move — a caller narrowing
    // `columns` or its cell floor. No-op on mount, where both sides are 1.
    React.useEffect(() => {
        const next = resolveColumnCountForContentWidth(measuredContentWidthRef.current);
        setMeasuredColumns((current) => (current === next ? current : next));
    }, [resolveColumnCountForContentWidth]);

    const handleMeasureLayout = React.useCallback((event: LayoutChangeEvent) => {
        const measuredWidthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(measuredWidthPx) || measuredWidthPx <= 0) return;
        // `onLayout` reports the border box; the padding is this container's own
        // and is never available to a column.
        const contentWidthPx = measuredWidthPx - (2 * paddingHorizontal);
        measuredContentWidthRef.current = contentWidthPx;
        const next = resolveColumnCountForContentWidth(contentWidthPx);
        setMeasuredColumns((current) => (current === next ? current : next));
    }, [paddingHorizontal, resolveColumnCountForContentWidth]);

    const activeColumns = explicitColumns != null
        ? Math.max(1, Math.floor(explicitColumns))
        : measuredColumns;
    const contextValue = React.useMemo<ItemGroupColumnsContextValue>(() => ({
        activeColumns,
    }), [activeColumns]);

    return (
        <ItemGroupColumnsContext.Provider value={contextValue}>
            <View
                // A caller that passed a count already measured; measuring again
                // here would make the same number have two owners.
                onLayout={explicitColumns != null ? undefined : handleMeasureLayout}
                style={[
                    styles.container,
                    {
                        paddingHorizontal,
                        paddingVertical: props.paddingVertical ?? 16,
                        columnGap,
                        rowGap: props.rowGap ?? 16,
                    },
                    props.style,
                ]}
            >
                {props.children}
            </View>
        </ItemGroupColumnsContext.Provider>
    );
});

export const ItemGroupColumn = React.memo<ItemGroupColumnProps>((props) => {
    const styles = stylesheet;
    const { activeColumns } = React.useContext(ItemGroupColumnsContext);
    const resolvedSpan = Math.max(1, Math.min(props.span ?? 1, activeColumns));
    const isFullWidth = activeColumns === 1 || resolvedSpan >= activeColumns;

    return (
        <View
            style={[
                styles.column,
                isFullWidth
                    ? styles.fullWidthColumn
                    : [
                        styles.flexibleColumn,
                        {
                            flexGrow: resolvedSpan,
                        },
                    ],
                props.style,
            ]}
        >
            {props.children}
        </View>
    );
});
