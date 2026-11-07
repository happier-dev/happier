import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { SelectableRow, type SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';
import type { SelectableMenuCategory, SelectableMenuCategoryDecorations, SelectableMenuItem } from './selectableMenuTypes';
import { Text } from '@/components/ui/text/Text';
import type { ScrollItemLayoutHandler } from '@/components/ui/scroll/useScrollRectIntoView';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { focusFirstEntryWithin } from '@/keyboard/webOverlayFocusContainment';

type RowFrameStyle = React.ComponentProps<typeof View>['style'];

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
    getAttribute?: (name: string) => string | null;
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

const useBrowserLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

function startsFromInteractiveDescendant(event: WebMouseDownActivationEvent, rowTestID: string): boolean {
    const target = asElementLike(event.target ?? event.nativeEvent?.target);
    const currentTarget = asElementLike(event.currentTarget ?? event.nativeEvent?.currentTarget);
    if (!target || !currentTarget || target === currentTarget) return false;
    if (typeof target.closest !== 'function') return false;

    const interactiveAncestor = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
    if (!interactiveAncestor || interactiveAncestor === currentTarget) return false;
    const interactiveElement = asElementLike(interactiveAncestor);
    if (interactiveElement?.getAttribute?.('data-testid') === rowTestID) return false;
    if (typeof currentTarget.contains !== 'function') return true;
    return currentTarget.contains(interactiveAncestor);
}

function installWebTrailingClickBlocker(): void {
    if (typeof document === 'undefined') return;

    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
        document.removeEventListener('click', blockClick, true);
        document.removeEventListener('pointerup', blockRelease, true);
        document.removeEventListener('mouseup', blockRelease, true);
        if (safetyTimer !== null) clearTimeout(safetyTimer);
        safetyTimer = null;
    };
    const blockClick = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        cleanup();
    };
    let releaseCleanupScheduled = false;
    const blockRelease = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (releaseCleanupScheduled) return;
        releaseCleanupScheduled = true;
        // Pointer/mouse release and click are one activation sequence. Keep all
        // three blocked, then retire the shield in the next task.
        setTimeout(cleanup, 0);
    };

    document.addEventListener('click', blockClick, true);
    document.addEventListener('pointerup', blockRelease, true);
    document.addEventListener('mouseup', blockRelease, true);
    safetyTimer = setTimeout(cleanup, 1_000);
}

function useWebRowFrameLayout(
    rowAnchorRef: React.RefObject<View | null>,
    onLayout: ScrollItemLayoutHandler | undefined,
) {
    const previousLayoutRef = React.useRef<Readonly<{ y: number; height: number }> | null>(null);

    useBrowserLayoutEffect(() => {
        if (Platform.OS !== 'web' || !onLayout) return undefined;
        const node = rowAnchorRef.current as unknown as HTMLElement | null;
        if (!node) return undefined;

        const emitLayout = () => {
            const layout = {
                y: node.offsetTop,
                height: node.offsetHeight,
            };
            const previousLayout = previousLayoutRef.current;
            if (previousLayout?.y === layout.y && previousLayout.height === layout.height) return;
            previousLayoutRef.current = layout;
            onLayout({ nativeEvent: { layout } });
        };

        emitLayout();

        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(emitLayout);
        observer.observe(node);
        return () => {
            observer.disconnect();
        };
    }, [onLayout, rowAnchorRef]);
}

function SelectableMenuRowFrame(props: {
    children: React.ReactNode;
    rowAnchorRef: React.RefObject<View | null>;
    testID: string;
    style: RowFrameStyle;
    onMouseDownCapture: ((event: unknown) => void) | undefined;
    onKeyDown: ((event: unknown) => void) | undefined;
    onPointerEnter: (() => void) | undefined;
    onLayout: ScrollItemLayoutHandler | undefined;
}) {
    useWebRowFrameLayout(props.rowAnchorRef, props.onLayout);

    if (Platform.OS === 'web') {
        return React.createElement(
            'div',
            {
                ref: props.rowAnchorRef as unknown as React.RefObject<HTMLDivElement>,
                ...(typeof document === 'undefined' ? { testID: props.testID, onLayout: props.onLayout } : {}),
                'data-testid': props.testID,
                style: props.style as React.CSSProperties | undefined,
                onMouseDownCapture: props.onMouseDownCapture,
                onKeyDown: props.onKeyDown,
                onPointerEnter: props.onPointerEnter,
            },
            props.children,
        );
    }

    return (
        <View
            ref={props.rowAnchorRef}
            testID={props.testID}
            style={props.style}
            onPointerEnter={props.onPointerEnter}
            {...(props.onLayout ? { onLayout: props.onLayout } : {})}
        >
            {props.children}
        </View>
    );
}

/**
 * The row frame is a plain element on the web: it lays its row out as a View would (a flex column
 * that stretches its child), or the row, a <button>, shrinks to its label and its highlight covers
 * only part of the menu. Plain objects, because the web frame is not a React Native view.
 */
const ROW_FRAME_STYLE = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', width: '100%' } as const;
const SUBMENU_ANCHOR_FRAME_STYLE = { ...ROW_FRAME_STYLE, position: 'relative' } as const;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: MENU_ROW_METRICS.insetPx,
    },
    leadingSlot: {
        width: MENU_ROW_METRICS.iconGlyphSizePx,
        height: MENU_ROW_METRICS.iconGlyphSizePx,
    },
    // A field's option list (`rowKind="item"`) holds its box in the field's 32pt leading column.
    itemCheckBoxFrame: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyContainer: {
        padding: theme.space.s48,
        alignItems: 'center',
    },
    emptyText: {
        color: theme.colors.input.placeholder,
        ...Typography.variant('label', 'regular'),
    },
    // A group label is sentence case, quiet and on the rows' text edge ("Ask an agent to"): never an
    // uppercase eyebrow over a menu.
    categoryTitle: {
        ...Typography.variant('meta', 'semiBold'),
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
        color: theme.colors.text.secondary,
    },
    categoryHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
    },
    categoryHeaderTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    categoryNote: {
        ...Typography.variant('meta', 'regular'),
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s8,
        color: theme.colors.text.tertiary,
    },
    categorySeparator: {
        height: StyleSheet.hairlineWidth,
        marginHorizontal: theme.space.s12,
        marginVertical: MENU_ROW_METRICS.insetPx,
        backgroundColor: theme.colors.border.subtle,
    },
    itemRowPressable: {
        alignSelf: 'stretch',
        marginHorizontal: MENU_ROW_METRICS.insetPx,
        borderRadius: MENU_ROW_METRICS.radiusPx,
    },

    // The submenu anchors to the whole row, so it opens beside its parent menu (to the right, or to
    // the left when there is no room) and never on top of it.
    submenuAnchor: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
}));

export type SelectableMenuResultsHandle = Readonly<{ focusItem: (index: number) => void }>;

type SelectableMenuResultsProps = {
    /** Decorated destinations must remain mounted until press so browser dragging can start. */
    wrapItem?: (item: SelectableMenuItem, content: React.ReactNode) => React.ReactNode;
    categories: ReadonlyArray<SelectableMenuCategory>;
    selectedIndex: number;
    onSelectionChange: (index: number) => void;
    onPressItem: (item: SelectableMenuItem) => void;
    onOpenSubmenu?: (itemId: string, anchorRef: React.RefObject<unknown>) => void;
    rowVariant: SelectableRowVariant;
    emptyLabel?: string | null;
    showCategoryTitles?: boolean;
    /** Untitled groups read apart: a hairline between them (a menu's choices, then its operations). */
    separateCategories?: boolean;
    categoryDecorations?: SelectableMenuCategoryDecorations;
    rowKind?: 'selectableRow' | 'item';
    itemProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'icon' | 'rightElement' | 'selected' | 'disabled' | 'showChevron' | 'showDivider' | 'onPress'>
    >;
    registerItemLayout?: (key: string) => ScrollItemLayoutHandler;
    /** Shared DropdownMenu keyboard policy, delegated through each focusable row. */
    onKeyDown?: (event: unknown) => void;
};

/** A multi-select row's leading box: checked or empty, so a row reads as checkable before it is on. */
function MenuCheckBox(props: Readonly<{ checked: boolean; rowKind: 'selectableRow' | 'item' }>) {
    const { theme } = useUnistyles();
    const glyph = (
        <Icon
            name={props.checked ? 'check-square' : 'square'}
            size={props.rowKind === 'item' ? ICON_SIZE.md : MENU_ROW_METRICS.iconGlyphSizePx}
            weight={props.checked ? 'fill' : 'regular'}
            color={props.checked ? theme.colors.text.primary : theme.colors.text.secondary}
        />
    );
    return props.rowKind === 'item'
        ? <View style={stylesheet.itemCheckBoxFrame}>{glyph}</View>
        : glyph;
}

export const SelectableMenuResults = React.forwardRef<SelectableMenuResultsHandle, SelectableMenuResultsProps>(function SelectableMenuResults(props, ref) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    // A choice row (radio) shows which one is current; the mark yields to a row's own trailing content.
    const checkMark = <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.primary} />;
    const rowAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());
    const submenuAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());

    const allItems = React.useMemo(() => props.categories.flatMap((c) => c.items), [props.categories]);
    // A menu where only some rows carry an icon keeps one text edge: the others hold the same empty slot.
    const reservesLeadingSlot = React.useMemo(() => allItems.some((item) => item.left != null || item.multiSelect === true), [allItems]);
    React.useImperativeHandle(ref, () => ({
        focusItem(index) {
            if (Platform.OS !== 'web') return;
            const item = allItems[index];
            if (!item || item.disabled) return;
            const node = rowAnchorRefs.current.get(String(item.id))?.current as unknown as HTMLElement | null;
            if (node) focusFirstEntryWithin(node);
        },
    }), [allItems]);
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
        installWebTrailingClickBlocker();
        props.onPressItem(item);
    }, [props.onPressItem]);
    const handlePressItem = React.useCallback((item: SelectableMenuItem) => {
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
    let renderedCategories = 0;
    const showCategoryTitles = props.showCategoryTitles !== false;
    const rowKind = props.rowKind ?? 'selectableRow';

    const content = (
        <View style={styles.container}>
            {props.categories.map((category) => {
                if (category.items.length === 0) return null;

                const categoryStartIndex = currentIndex;
                // Checked rows among siblings are one choice (radios) unless they say they are independent
                // (multi-select); a lone checked row is an on/off toggle.
                const checkRole = category.items.filter((entry) => entry.checked !== undefined).length > 1
                    && !category.items.some((entry) => entry.multiSelect === true) ? 'radio' as const : 'checkbox' as const;
                const categoryItems = category.items.map((item, idx) => {
                    const itemIndex = categoryStartIndex + idx;
                    const isSelected = itemIndex === props.selectedIndex;
                    const right = item.right ?? (item.checked === true && item.multiSelect !== true ? checkMark : null);
                    const left = item.left
                        ?? (item.multiSelect === true ? <MenuCheckBox checked={item.checked === true} rowKind={rowKind} /> : null)
                        ?? (reservesLeadingSlot ? <View style={styles.leadingSlot} /> : null);
                    currentIndex++;
                    const rowAnchorRef = getRowAnchorRef(String(item.id));
                    const submenuAnchorRef = getSubmenuAnchorRef(String(item.id));
                    const testIdSafeItemId = String(item.id).replace(/[^a-zA-Z0-9_-]/g, '_');
                    const optionTestID = item.testID ?? `dropdown-option-${testIdSafeItemId}`;
                    const handleOptionMouseDownCapture =
                        Platform.OS === 'web' && !props.wrapItem
                            ? ((event: unknown) => {
                                const activationEvent = asWebMouseDownActivationEvent(event);
                                if (item.disabled) return;
                                if (!isPrimaryWebActivationEvent(activationEvent)) return;
                                if (startsFromInteractiveDescendant(activationEvent, optionTestID)) return;
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
                            // A dropdown row is a menu row, whatever density the user has chosen.
                            rowRole="menu"
                            pressableStyle={[
                                props.itemProps?.pressableStyle,
                                styles.itemRowPressable,
                            ]}
                            testID={optionTestID}
                            title={item.title}
                            titleStyle={item.rowTitleStyle}
                            subtitle={item.subtitleNode ?? item.subtitle}
                            accessibilityLabel={item.accessibilityLabel}
                            accessibilityRole={item.checked === undefined ? props.itemProps?.accessibilityRole : checkRole}
                            webRole={item.checked === undefined ? props.itemProps?.webRole : checkRole}
                            accessibilityChecked={item.checked ?? props.itemProps?.accessibilityChecked}
                            icon={left}
                            rightElement={right}
                            selected={isSelected}
                            disabled={item.disabled}
                            showChevron={false}
                            showDivider={false}
                            onPress={() => {
                                if (item.disabled) return;
                                if (handleOpenSubmenu(item, rowAnchorRef as React.RefObject<unknown>)) return;
                                handlePressItem(item);
                            }}
                        />
                    ) : (
                        <SelectableRow
                            variant={props.rowVariant}
                            presentation="menu"
                            selected={isSelected}
                            disabled={item.disabled}
                            left={left}
                            leftGap={item.leftGap}
                            right={right}
                            title={item.titleNode ?? item.title}
                            subtitle={item.subtitleNode ?? item.subtitle}
                            accessibilityLabel={item.accessibilityLabel}
                            accessibilityRole={item.checked === undefined ? undefined : checkRole}
                            accessibilityChecked={item.checked}
                            containerStyle={item.rowContainerStyle}
                            titleStyle={item.rowTitleStyle}
                            subtitleStyle={item.rowSubtitleStyle}
                            testID={optionTestID}
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

                    const scrollFrameLayout = props.registerItemLayout?.(item.id);
                    const rowFrameTestID = `${optionTestID}:scroll-frame`;
                    const rowFramePointerEnter = Platform.OS === 'web' && item.hasSubmenu ? () => {
                        props.onSelectionChange(itemIndex);
                        handleOpenItemSubmenu();
                    } : undefined;
                    const rowFrameChildren = (
                        <>
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
                        </>
                    );
                    return (
                        <SelectableMenuRowFrame
                            key={item.id}
                            testID={rowFrameTestID}
                            rowAnchorRef={rowAnchorRef}
                            style={item.hasSubmenu ? SUBMENU_ANCHOR_FRAME_STYLE : ROW_FRAME_STYLE}
                            onMouseDownCapture={handleOptionMouseDownCapture}
                            onKeyDown={Platform.OS === 'web' ? props.onKeyDown : undefined}
                            onPointerEnter={rowFramePointerEnter}
                            onLayout={scrollFrameLayout}
                        >
                            {props.wrapItem ? props.wrapItem(item, rowFrameChildren) : rowFrameChildren}
                        </SelectableMenuRowFrame>
                    );
                });

                const decoration = props.categoryDecorations?.[category.title];
                const separated = props.separateCategories === true && renderedCategories > 0;
                renderedCategories++;
                return (
                    <View key={category.id}>
                        {separated ? <View style={styles.categorySeparator} /> : null}
                        {showCategoryTitles && category.title.trim().length > 0 ? (
                            decoration?.icon ? (
                                <View style={styles.categoryHeader} accessibilityRole="header">
                                    {decoration.icon}
                                    <Text style={styles.categoryHeaderTitle}>{category.title}</Text>
                                </View>
                            ) : (
                                <Text style={styles.categoryTitle} accessibilityRole="header">
                                    {category.title}
                                </Text>
                            )
                        ) : null}
                        {categoryItems}
                        {decoration?.note ? <Text style={styles.categoryNote}>{decoration.note}</Text> : null}
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
});
