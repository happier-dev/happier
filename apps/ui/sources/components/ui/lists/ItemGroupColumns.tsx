import * as React from 'react';
import { View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveViewportClass, type ViewportClass } from '@/utils/platform/viewportClass';

type ItemGroupColumnsContextValue = Readonly<{
    activeColumns: number;
}>;

const ItemGroupColumnsContext = React.createContext<ItemGroupColumnsContextValue>({ activeColumns: 1 });

const VIEWPORT_CLASS_ORDER: Record<ViewportClass, number> = Object.freeze({
    compact: 0,
    medium: 1,
    expanded: 2,
    wide: 3,
});

export type ItemGroupColumnsProps = Readonly<{
    children: React.ReactNode;
    columns?: 1 | 2 | 3;
    collapseBelow?: ViewportClass;
    style?: StyleProp<ViewStyle>;
    paddingHorizontal?: number;
    paddingVertical?: number;
    columnGap?: number;
    rowGap?: number;
}>;

export type ItemGroupColumnProps = Readonly<{
    children: React.ReactNode;
    span?: 1 | 2 | 3;
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

function resolveActiveColumns(params: Readonly<{
    viewportClass: ViewportClass;
    columns: number;
    collapseBelow: ViewportClass;
}>): number {
    return VIEWPORT_CLASS_ORDER[params.viewportClass] >= VIEWPORT_CLASS_ORDER[params.collapseBelow]
        ? Math.max(1, params.columns)
        : 1;
}

export const ItemGroupColumns = React.memo<ItemGroupColumnsProps>((props) => {
    const { width, height } = useWindowDimensions();
    const styles = stylesheet;
    const viewportClass = resolveViewportClass({ width, height });
    const activeColumns = resolveActiveColumns({
        viewportClass,
        columns: props.columns ?? 2,
        collapseBelow: props.collapseBelow ?? 'medium',
    });
    const contextValue = React.useMemo<ItemGroupColumnsContextValue>(() => ({
        activeColumns,
    }), [activeColumns]);

    return (
        <ItemGroupColumnsContext.Provider value={contextValue}>
            <View
                style={[
                    styles.container,
                    {
                        paddingHorizontal: props.paddingHorizontal ?? 16,
                        paddingVertical: props.paddingVertical ?? 16,
                        columnGap: props.columnGap ?? 12,
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
