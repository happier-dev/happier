import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
    HappierColumns,
    HappierColumn,
    type HappierColumnsProps,
    type HappierColumnProps,
} from '@happier-dev/plugin-ui/presentation';

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
    columns?: HappierColumnProps['columns'];
    style?: StyleProp<ViewStyle>;
}>;

// Preserve the core layout contract while both core and plugin authors use the
// same measured-width and stable-child presentation owner.
export const ItemGroupColumns = React.memo<ItemGroupColumnsProps>(function ItemGroupColumns(props) {
    return <HappierColumns {...props} style={props.style as HappierColumnsProps['style']} />;
});

export const ItemGroupColumn = React.memo<ItemGroupColumnProps>(function ItemGroupColumn(props) {
    return <HappierColumn {...props} style={props.style as HappierColumnProps['style']} />;
});
