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
    rowFrame: {
        width: '100%',
    },
    itemRowPressable: {
        width: '100%',
    },
    submenuAnchorFrame: {
        width: '100%',
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
                            pressableStyle={[
                                props.itemProps?.pressableStyle,
                                styles.itemRowPressable,
                            ]}
                            testID={optionTestID}
                            title={item.title}
                            subtitle={item.subtitleNode ?? item.subtitle}
                            accessibilityLabel={item.accessibilityLabel}
                            icon={item.left}
                            rightElement={item.right}
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
                            selected={isSelected}
                            disabled={item.disabled}
                            left={item.left}
                            leftGap={item.leftGap}
                            right={item.right}
                            title={item.titleNode ?? item.title}
                            subtitle={item.subtitleNode ?? item.subtitle}
                            accessibilityLabel={item.accessibilityLabel}
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

                    const scrollFrameLayout = props.registerItemLayout?.(String(itemIndex));
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
                            style={item.hasSubmenu ? styles.submenuAnchorFrame : styles.rowFrame}
                            onMouseDownCapture={handleOptionMouseDownCapture}
                            onPointerEnter={rowFramePointerEnter}
                            onLayout={scrollFrameLayout}
                        >
                            {rowFrameChildren}
                        </SelectableMenuRowFrame>
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
