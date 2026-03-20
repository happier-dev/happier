import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SelectableRow, type SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';
import type { SelectableMenuCategory, SelectableMenuItem } from './selectableMenuTypes';
import { Text } from '@/components/ui/text/Text';


const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 0,
    },
    emptyContainer: {
        padding: 48,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.input.placeholder,
        letterSpacing: -0.2,
        ...Typography.default(),
    },
    categoryTitle: {
        paddingHorizontal: 32,
        paddingTop: 16,
        paddingBottom: 8,
        fontSize: 12,
        color: theme.colors.input.placeholder,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
}));

export function SelectableMenuResults(props: {
    categories: ReadonlyArray<SelectableMenuCategory>;
    selectedIndex: number;
    onSelectionChange: (index: number) => void;
    onPressItem: (item: SelectableMenuItem) => void;
    rowVariant: SelectableRowVariant;
    emptyLabel?: string | null;
    showCategoryTitles?: boolean;
    rowKind?: 'selectableRow' | 'item';
    itemProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'icon' | 'rightElement' | 'selected' | 'disabled' | 'showChevron' | 'showDivider' | 'onPress'>
    >;
}) {
    const styles = stylesheet;
    const mouseDownActivatedItemIdRef = React.useRef<string | null>(null);

    const allItems = React.useMemo(() => props.categories.flatMap((c) => c.items), [props.categories]);

    if (props.categories.length === 0 || allItems.length === 0) {
        if (!props.emptyLabel) return null;
        return (
            <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>
                    {props.emptyLabel}
                </Text>
            </View>
        );
    }

    let currentIndex = 0;
    const showCategoryTitles = props.showCategoryTitles !== false;
    const rowKind = props.rowKind ?? 'selectableRow';
    const handleMouseDownActivatedPress = React.useCallback((item: SelectableMenuItem) => {
        mouseDownActivatedItemIdRef.current = String(item.id);
        props.onPressItem(item);
    }, [props.onPressItem]);
    const handlePressItem = React.useCallback((item: SelectableMenuItem) => {
        const itemId = String(item.id);
        if (Platform.OS === 'web' && mouseDownActivatedItemIdRef.current === itemId) {
            mouseDownActivatedItemIdRef.current = null;
            return;
        }
        props.onPressItem(item);
    }, [props.onPressItem]);

    const content = (
        <View style={styles.container}>
            {props.categories.map((category) => {
                if (category.items.length === 0) return null;

                const categoryStartIndex = currentIndex;
                const categoryItems = category.items.map((item, idx) => {
                    const itemIndex = categoryStartIndex + idx;
                    const isSelected = itemIndex === props.selectedIndex;
                    currentIndex++;
                    const testIdSafeItemId = String(item.id).replace(/[^a-zA-Z0-9_-]/g, '_');
                    const optionTestID = `dropdown-option-${testIdSafeItemId}`;
                    const handleOptionMouseDownCapture =
                        Platform.OS === 'web'
                            ? ((event: unknown) => {
                                if (item.disabled) return;
                                if (!(event instanceof MouseEvent)) return;
                                if (typeof event.button === 'number' && event.button !== 0) return;
                                event.preventDefault();
                                event.stopPropagation();
                                handleMouseDownActivatedPress(item);
                            })
                            : undefined;
                    const itemNode = rowKind === 'item' ? (
                        <Item
                            {...(props.itemProps ?? {})}
                            testID={optionTestID}
                            title={item.title}
                            subtitle={item.subtitleNode ?? item.subtitle}
                            icon={item.left}
                            rightElement={item.right}
                            selected={isSelected}
                            disabled={item.disabled}
                            showChevron={false}
                            showDivider={false}
                            onMouseDownCapture={handleOptionMouseDownCapture}
                            onPress={() => {
                                if (item.disabled) return;
                                handlePressItem(item);
                            }}
                        />
                    ) : (
                        <SelectableRow
                            variant={props.rowVariant}
                            selected={isSelected}
                            disabled={item.disabled}
                            left={item.left}
                            leftGap={item.leftGap}
                            right={item.right}
                            title={item.titleNode ?? item.title}
                            subtitle={item.subtitleNode ?? item.subtitle}
                            containerStyle={item.rowContainerStyle}
                            titleStyle={item.rowTitleStyle}
                            subtitleStyle={item.rowSubtitleStyle}
                            testID={optionTestID}
                            onMouseDownCapture={handleOptionMouseDownCapture}
                            onPress={() => {
                                if (item.disabled) return;
                                handlePressItem(item);
                            }}
                            onHover={() => {
                                if (item.disabled) return;
                                props.onSelectionChange(itemIndex);
                            }}
                        />
                    );

                    return React.cloneElement(itemNode, {
                        key: item.id,
                    });
                });

                return (
                    <View key={category.id}>
                        {showCategoryTitles && category.title.trim().length > 0 ? (
                            <Text style={styles.categoryTitle}>
                                {category.title}
                            </Text>
                        ) : null}
                        {categoryItems}
                    </View>
                );
            })}
        </View>
    );

    if (rowKind === 'item') {
        // Ensure Item's "selected row background" behavior is enabled,
        // and prevent row-position context from leaking into the popover.
        return (
            <ItemGroupRowPositionBoundary>
                <ItemGroupSelectionContext.Provider value={{ selectableItemCount: 2 }}>
                    {content}
                </ItemGroupSelectionContext.Provider>
            </ItemGroupRowPositionBoundary>
        );
    }

    return content;
}
