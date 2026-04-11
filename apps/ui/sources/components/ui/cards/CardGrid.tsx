import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { ItemGroupColumn, ItemGroupColumns, type ItemGroupColumnProps } from '@/components/ui/lists/ItemGroupColumns';
import type { ViewportClass } from '@/utils/platform/viewportClass';

type CardGridProps = Readonly<{
    children: React.ReactNode;
    columns?: 1 | 2 | 3 | 4;
    collapseBelow?: ViewportClass;
    style?: StyleProp<ViewStyle>;
    columnGap?: number;
    rowGap?: number;
}>;

export function CardGrid(props: CardGridProps): React.ReactElement {
    const {
        children,
        columns = 2,
        collapseBelow = 'medium',
        style,
        columnGap = 12,
        rowGap = 12,
    } = props;

    return (
        <ItemGroupColumns
            columns={columns}
            collapseBelow={collapseBelow}
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
