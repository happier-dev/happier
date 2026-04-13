import * as React from 'react';
import { View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    resolveItemGroupActiveColumns,
} from '@/components/ui/lists/ItemGroupColumns';
import { resolveViewportClass, type ViewportClass } from '@/utils/platform/viewportClass';

import { resolveCardMasonryColumns } from './resolveCardMasonryColumns';

type CardMasonryHeight = 'compact' | 'standard' | 'tall' | 'hero';

type CardMasonryProps = Readonly<{
    children: React.ReactNode;
    columns?: 1 | 2 | 3 | 4;
    collapseBelow?: ViewportClass;
    style?: StyleProp<ViewStyle>;
    columnGap?: number;
    rowGap?: number;
}>;

type CardMasonryItemProps = Readonly<{
    children: React.ReactNode;
    height?: CardMasonryHeight;
    style?: StyleProp<ViewStyle>;
}>;

const HEIGHT_WEIGHT: Record<CardMasonryHeight, number> = Object.freeze({
    compact: 1,
    standard: 2,
    tall: 3,
    hero: 4,
});

const styles = StyleSheet.create(() => ({
    masonry: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    column: {
        flex: 1,
        minWidth: 0,
    },
    item: {
        width: '100%',
        minWidth: 0,
    },
}));

type MasonryRenderableItem = Readonly<{
    key: string;
    height: CardMasonryHeight;
    element: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

export function CardMasonry(props: CardMasonryProps): React.ReactElement | null {
    const {
        children,
        columns = 3,
        collapseBelow = 'medium',
        style,
        columnGap = 12,
        rowGap = 12,
    } = props;
    const { width, height } = useWindowDimensions();
    const viewportClass = resolveViewportClass({ width, height });
    const activeColumns = resolveItemGroupActiveColumns({
        viewportClass,
        columns,
        collapseBelow,
    });

    const items = React.useMemo<MasonryRenderableItem[]>(() => {
        return React.Children.toArray(children)
            .filter(React.isValidElement<CardMasonryItemProps>)
            .map((child, index) => {
                const key = child.key != null ? String(child.key) : `masonry-item-${index}`;
                return {
                    key,
                    height: child.props.height ?? 'standard',
                    style: child.props.style,
                    element: child.props.children,
                };
            });
    }, [children]);

    const columnsByItemKey = React.useMemo(() => {
        const resolvedColumns = resolveCardMasonryColumns(
            items.map((item) => ({
                key: item.key,
                weight: HEIGHT_WEIGHT[item.height],
            })),
            activeColumns,
        );
        return resolvedColumns.map((columnKeys) =>
            columnKeys
                .map((key) => items.find((item) => item.key === key) ?? null)
                .filter((item): item is MasonryRenderableItem => item != null),
        );
    }, [activeColumns, items]);

    if (items.length === 0) {
        return null;
    }

    return (
        <View style={[styles.masonry, { columnGap }, style]}>
            {columnsByItemKey.map((column, columnIndex) => (
                <View
                    key={`masonry-column-${columnIndex}`}
                    style={[styles.column, { rowGap }]}
                >
                    {column.map((item) => (
                        <View key={item.key} style={[styles.item, item.style]}>
                            {item.element}
                        </View>
                    ))}
                </View>
            ))}
        </View>
    );
}

export function CardMasonryItem(props: CardMasonryItemProps): React.ReactElement {
    return <>{props.children}</>;
}
