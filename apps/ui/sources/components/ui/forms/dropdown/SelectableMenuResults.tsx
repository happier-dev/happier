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
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import type { ScrollItemLayoutHandler } from '@/components/ui/scroll/useScrollRectIntoView';

type WebMouseDownActivationEvent = Readonly<{
    button?: number;
    currentTarget?: unknown;
    target?: unknown;
    nativeEvent?: Readonly<{
        button?: number;
        currentTarget?: unknown;
        target?: unknown;
    }>;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

function asWebMouseDownActivationEvent(event: unknown): WebMouseDownActivationEvent {
    if (!event || typeof event !== 'object') {
        return {};
    }
    return event as WebMouseDownActivationEvent;
}

type ElementLike = Readonly<{
    contains?: (node: unknown) => boolean;
    closest?: (selector: string) => unknown;
}>;

function asElementLike(value: unknown): ElementLike | null {
    if (!value || typeof value !== 'object') return null;
    return value as ElementLike;
}

const INTERACTIVE_DESCENDANT_SELECTOR = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
].join(',');

function startsFromInteractiveDescendant(event: WebMouseDownActivationEvent): boolean {
    const target = asElementLike(event.target ?? event.nativeEvent?.target);
    const currentTarget = asElementLike(event.currentTarget ?? event.nativeEvent?.currentTarget);
    if (!target || !currentTarget || target === currentTarget) return false;
    if (typeof target.closest !== 'function') return false;

    const interactiveAncestor = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
    if (!interactiveAncestor || interactiveAncestor === currentTarget) return false;
    if (typeof currentTarget.contains !== 'function') return true;
    return currentTarget.contains(interactiveAncestor);
}

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
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 8,
        color: theme.colors.input.placeholder,
    },
    submenuAnchorFrame: {
        position: 'relative',
    },
    submenuAnchor: {
        position: 'absolute',
        top: 0,
        right: -2,
        bottom: 0,
        width: 4,
    },
}));

export function SelectableMenuResults(props: {
    categories: ReadonlyArray<SelectableMenuCategory>;
    selectedIndex: number;
    onSelectionChange: (index: number) => void;
    onPressItem: (item: SelectableMenuItem) => void;
    onOpenSubmenu?: (itemId: string, anchorRef: React.RefObject<unknown>) => void;
    rowVariant: SelectableRowVariant;
    emptyLabel?: string | null;
    showCategoryTitles?: boolean;
    rowKind?: 'selectableRow' | 'item';
    itemProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'icon' | 'rightElement' | 'selected' | 'disabled' | 'showChevron' | 'showDivider' | 'onPress'>
    >;
    registerItemLayout?: (key: string) => ScrollItemLayoutHandler;
}) {
    const styles = stylesheet;
    const mouseDownActivatedItemIdRef = React.useRef<string | null>(null);
    const rowAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());
    const submenuAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());

    const allItems = React.useMemo(() => props.categories.flatMap((c) => c.items), [props.categories]);
    const getRowAnchorRef = React.useCallback((itemId: string): React.RefObject<View | null> => {
        const existing = rowAnchorRefs.current.get(itemId);
        if (existing) return existing;
        const created = React.createRef<View>();
        rowAnchorRefs.current.set(itemId, created);
        return created;
    }, []);
    const getSubmenuAnchorRef = React.useCallback((itemId: string): React.RefObject<View | null> => {
        const existing = submenuAnchorRefs.current.get(itemId);
        if (existing) return existing;
        const created = React.createRef<View>();
        submenuAnchorRefs.current.set(itemId, created);
        return created;
    }, []);
    const handleOpenSubmenu = React.useCallback((item: SelectableMenuItem, anchorRef: React.RefObject<unknown>) => {
        if (!item.hasSubmenu || item.disabled) return false;
        props.onOpenSubmenu?.(item.id, anchorRef);
        return true;
    }, [props]);
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
    const isPrimaryWebActivationEvent = React.useCallback((event: WebMouseDownActivationEvent) => {
        const button = event.nativeEvent?.button ?? event.button;
        return typeof button !== 'number' || button === 0;
    }, []);

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

    const content = (
        <View style={styles.container}>
            {props.categories.map((category) => {
                if (category.items.length === 0) return null;

                const categoryStartIndex = currentIndex;
                const categoryItems = category.items.map((item, idx) => {
                    const itemIndex = categoryStartIndex + idx;
                    const isSelected = itemIndex === props.selectedIndex;
                    currentIndex++;
                    const rowAnchorRef = getRowAnchorRef(String(item.id));
                    const submenuAnchorRef = getSubmenuAnchorRef(String(item.id));
                    const testIdSafeItemId = String(item.id).replace(/[^a-zA-Z0-9_-]/g, '_');
                    const optionTestID = item.testID ?? `dropdown-option-${testIdSafeItemId}`;
                    const handleOptionMouseDownCapture =
                        Platform.OS === 'web'
                            ? ((event: unknown) => {
                                const activationEvent = asWebMouseDownActivationEvent(event);
                                if (item.disabled) return;
                                if (!isPrimaryWebActivationEvent(activationEvent)) return;
                                if (startsFromInteractiveDescendant(activationEvent)) return;
                                activationEvent.preventDefault?.();
                                activationEvent.stopPropagation?.();
                                if (handleOpenSubmenu(item, submenuAnchorRef as React.RefObject<unknown>)) return;
                                handleMouseDownActivatedPress(item);
                            })
                            : undefined;
                    const handleOpenItemSubmenu = () => {
                        handleOpenSubmenu(item, submenuAnchorRef as React.RefObject<unknown>);
                    };
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
                                if (handleOpenSubmenu(item, rowAnchorRef as React.RefObject<unknown>)) return;
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
                                if (handleOpenSubmenu(item, rowAnchorRef as React.RefObject<unknown>)) return;
                                handlePressItem(item);
                            }}
                            onHover={() => {
                                if (item.disabled) return;
                                props.onSelectionChange(itemIndex);
                                handleOpenItemSubmenu();
                            }}
                        />
                    );

                    const scrollFrameLayout = props.registerItemLayout?.(String(itemIndex));
                    return (
                        <View
                            ref={rowAnchorRef}
                            key={item.id}
                            testID={`${optionTestID}:scroll-frame`}
                            style={item.hasSubmenu ? styles.submenuAnchorFrame : undefined}
                            onPointerEnter={Platform.OS === 'web' && item.hasSubmenu ? () => {
                                props.onSelectionChange(itemIndex);
                                handleOpenItemSubmenu();
                            } : undefined}
                            {...(scrollFrameLayout ? { onLayout: scrollFrameLayout } : {})}
                        >
                            {itemNode}
                            {item.hasSubmenu ? (
                                <View
                                    ref={submenuAnchorRef}
                                    collapsable={false}
                                    pointerEvents="none"
                                    testID={`${optionTestID}:submenu-anchor`}
                                    style={styles.submenuAnchor}
                                />
                            ) : null}
                        </View>
                    );
                });

                return (
                    <View key={category.id}>
                        {showCategoryTitles && category.title.trim().length > 0 ? (
                            <Eyebrow style={styles.categoryTitle}>
                                {category.title}
                            </Eyebrow>
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
                <ItemGroupSelectionContext.Provider value={{ selectableItemCount: allItems.length }}>
                    {content}
                </ItemGroupSelectionContext.Provider>
            </ItemGroupRowPositionBoundary>
        );
    }

    return content;
}
