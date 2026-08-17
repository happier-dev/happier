import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { ItemGroupColumn, ItemGroupColumns, type ItemGroupColumnProps } from '@/components/ui/lists/ItemGroupColumns';

/**
 * Narrowest a card cell may become before a column is given up.
 *
 * A card carries a short label above a large numeric value, so it reads fine far
 * below the 320px list-row floor — but not below roughly this width, where the
 * label wraps away from its value. Sized so a phone-width grid still collapses
 * to one card per line.
 */
export const CARD_GRID_COLUMN_MIN_WIDTH_PX = 200;

type CardGridProps = Readonly<{
    children: React.ReactNode;
    columns?: 1 | 2 | 3 | 4;
    /** Override the cell floor when the cards carry unusually wide content. */
    minColumnWidthPx?: number;
    style?: StyleProp<ViewStyle>;
    columnGap?: number;
    rowGap?: number;
}>;

export function CardGrid(props: CardGridProps): React.ReactElement {
    const {
        children,
        columns = 2,
        minColumnWidthPx = CARD_GRID_COLUMN_MIN_WIDTH_PX,
        style,
        columnGap = 12,
        rowGap = 12,
    } = props;

    return (
        <ItemGroupColumns
            columns={columns}
            minColumnWidthPx={minColumnWidthPx}
            paddingHorizontal={0}
            paddingVertical={0}
            columnGap={columnGap}
            rowGap={rowGap}
            style={style}
        >
            {children}
        </ItemGroupColumns>
    );
}

export function CardGridColumn(props: ItemGroupColumnProps): React.ReactElement {
    return <ItemGroupColumn {...props} />;
}
