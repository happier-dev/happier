import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
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

function readPointerType(event: unknown): string | null {
    const value = (event as { nativeEvent?: { pointerType?: unknown }; pointerType?: unknown } | null);
    const pointerType = value?.nativeEvent?.pointerType ?? value?.pointerType;
    return typeof pointerType === 'string' ? pointerType : null;
}

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

const SWATCH_HIT_SIZE = 44;
const SWATCH_HIGHLIGHT_SIZE = 34;
const SWATCH_RING_SIZE = 26;
const SWATCH_FILL_SIZE = 18;

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
        color: theme.colors.input.placeholder,
    },
    // Targets abut (no gap) so 44pt hit areas never overlap; the visible geometry is concentric:
    // highlight 34 → ring 26 (2px stroke, 2px gap) → fill 18.
    swatchRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: 8,
        paddingVertical: 2,
    },
    swatchHit: {
        width: SWATCH_HIT_SIZE,
        height: SWATCH_HIT_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    swatchHitPressed: {
        opacity: 0.7,
    },
    swatchHighlight: {
        width: SWATCH_HIGHLIGHT_SIZE,
        height: SWATCH_HIGHLIGHT_SIZE,
        borderRadius: SWATCH_HIGHLIGHT_SIZE / 2,
        // Reserved so the highlight outline never shifts the swatch.
        borderWidth: 1,
        borderColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
    },
    // The menu row's selected treatment (SelectableRow rowSelected), sized to a swatch.
    swatchHighlightActive: {
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderColor: theme.colors.border.default,
    },
    swatchRing: {
        width: SWATCH_RING_SIZE,
        height: SWATCH_RING_SIZE,
        borderRadius: SWATCH_RING_SIZE / 2,
        borderWidth: 2,
        borderColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
    },
    swatchRingChecked: {
        borderColor: theme.colors.text.primary,
    },
    // "No colour": an unfilled ring, struck through on the diagonal.
    swatchFillEmpty: {
        borderWidth: 1.5,
        borderColor: theme.colors.text.secondary,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    swatchStrike: {
        width: SWATCH_FILL_SIZE * 1.2,
        height: 1.5,
        backgroundColor: theme.colors.text.secondary,
        transform: [{ rotate: '-45deg' }],
    },
    swatchRingInherited: {
        borderColor: theme.colors.text.secondary,
        borderStyle: 'dashed',
        borderWidth: 1.5,
    },
    swatchFill: {
        width: SWATCH_FILL_SIZE,
        height: SWATCH_FILL_SIZE,
        borderRadius: SWATCH_FILL_SIZE / 2,
        // Keeps pale colours (yellow on a light surface) from dissolving into the menu.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
}));


type RenderedMenuEntry = Readonly<{ swatchGroup: string | null; node: React.ReactElement }>;

/** Consecutive swatches of one group wrap together in a single row; every other entry stays a row. */
function groupSwatchRuns(entries: readonly RenderedMenuEntry[], rowStyle: object): React.ReactNode[] {
    const output: React.ReactNode[] = [];
    let run: React.ReactElement[] = [];
    let runGroup: string | null = null;
    const flush = () => {
        if (run.length === 0) return;
        output.push(
            <View key={`swatch-row:${String(run[0]!.key)}`} style={rowStyle}>
                {run}
            </View>,
        );
        run = [];
    };
    for (const entry of entries) {
        if (entry.swatchGroup === null || entry.swatchGroup !== runGroup) flush();
        runGroup = entry.swatchGroup;
        if (entry.swatchGroup === null) output.push(entry.node);
        else run.push(entry.node);
    }
    flush();
    return output;
}

export function SelectableMenuResults(props: {
    categories: ReadonlyArray<SelectableMenuCategory>;
    selectedIndex: number;
    onSelectionChange: (index: number) => void;
    onPressItem: (item: SelectableMenuItem) => void;
    onOpenSubmenu?: (itemId: string, anchorRef: React.RefObject<unknown>) => void;
    /** The pointer rests on a row (mouse/pen); the menu decides whether its submenu opens or closes. */
    onHoverItem?: (item: SelectableMenuItem, anchorRef: React.RefObject<unknown>) => void;
    rowVariant: SelectableRowVariant;
    emptyLabel?: string | null;
    showCategoryTitles?: boolean;
    rowKind?: 'selectableRow' | 'item';
    itemProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'icon' | 'rightElement' | 'selected' | 'disabled' | 'showChevron' | 'showDivider' | 'onPress'>
    >;
    registerItemLayout?: (key: string) => ScrollItemLayoutHandler;
    /**
     * Swatches draw the highlight only once the person hovers or uses the keyboard: on a pointer open
     * the first swatch's highlight would read as a second selection beside the real ring.
     */
    swatchHighlightVisible?: boolean;
    /** Owner-supplied map so the menu can open a submenu from the keyboard at the same anchor a pointer uses. */
    submenuAnchorRegistry?: Map<string, React.RefObject<unknown>>;
}) {
    const styles = stylesheet;
    const mouseDownActivatedItemIdRef = React.useRef<string | null>(null);
    const rowAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());

    const allItems = React.useMemo(() => props.categories.flatMap((c) => c.items), [props.categories]);
    const submenuAnchorRegistry = props.submenuAnchorRegistry;
    // A submenu anchors to its whole row: placed beside the row, the measured flip to the left lands
    // outside the parent menu instead of on top of it.
    const getRowAnchorRef = React.useCallback((itemId: string): React.RefObject<View | null> => {
        const existing = rowAnchorRefs.current.get(itemId);
        if (existing) return existing;
        const created = React.createRef<View>();
        rowAnchorRefs.current.set(itemId, created);
        submenuAnchorRegistry?.set(itemId, created as React.RefObject<unknown>);
        return created;
    }, [submenuAnchorRegistry]);
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
                                if (handleOpenSubmenu(item, rowAnchorRef as React.RefObject<unknown>)) return;
                                handleMouseDownActivatedPress(item);
                            })
                            : undefined;
                    // Hover reports every row; the menu owns the intent (dwell, sibling close, grace).
                    const handleHoverItem = () => {
                        if (props.onHoverItem) {
                            props.onHoverItem(item, rowAnchorRef as React.RefObject<unknown>);
                            return;
                        }
                        handleOpenSubmenu(item, rowAnchorRef as React.RefObject<unknown>);
                    };
                    if (item.swatch) {
                        const swatchFrameLayout = props.registerItemLayout?.(String(itemIndex));
                        return {
                            swatchGroup: item.swatch.group ?? '',
                            node: (
                                <View
                                    ref={rowAnchorRef}
                                    key={item.id}
                                    testID={`${optionTestID}:scroll-frame`}
                                    {...(swatchFrameLayout ? { onLayout: swatchFrameLayout } : {})}
                                >
                                    <Pressable
                                        testID={optionTestID}
                                        accessibilityRole="radio"
                                        accessibilityLabel={item.title}
                                        accessibilityHint={item.subtitle}
                                        accessibilityState={{ checked: item.swatch.checked === true, disabled: item.disabled === true }}
                                        disabled={item.disabled}
                                        onPress={() => {
                                            if (item.disabled) return;
                                            handlePressItem(item);
                                        }}
                                        onHoverIn={() => {
                                            if (item.disabled) return;
                                            props.onSelectionChange(itemIndex);
                                            handleHoverItem();
                                        }}
                                        style={({ pressed }) => [styles.swatchHit, pressed ? styles.swatchHitPressed : null]}
                                        {...(Platform.OS === 'web' ? { onMouseDownCapture: handleOptionMouseDownCapture } : {})}
                                    >
                                        <View
                                            testID={isSelected && props.swatchHighlightVisible ? `${optionTestID}:highlight` : undefined}
                                            style={[styles.swatchHighlight, isSelected && props.swatchHighlightVisible ? styles.swatchHighlightActive : null]}
                                        >
                                                <View
                                                    style={[
                                                        styles.swatchRing,
                                                        item.swatch?.checked
                                                            ? styles.swatchRingChecked
                                                            : item.swatch?.inherited ? styles.swatchRingInherited : null,
                                                    ]}
                                                >
                                                    {item.swatch?.empty ? (
                                                        <View style={[styles.swatchFill, styles.swatchFillEmpty]}>
                                                            <View testID={`${optionTestID}:strike`} style={styles.swatchStrike} />
                                                        </View>
                                                    ) : (
                                                        <View style={[styles.swatchFill, { backgroundColor: item.swatch?.color }]} />
                                                    )}
                                                </View>
                                        </View>
                                    </Pressable>
                                </View>
                            ),
                        };
                    }
                    const itemNode = rowKind === 'item' ? (
                        <Item
                            {...(props.itemProps ?? {})}
                            // A dropdown row is a menu row, whatever density the user has chosen.
                            rowRole="menu"
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
                                handleHoverItem();
                            }}
                        />
                    );

                    const scrollFrameLayout = props.registerItemLayout?.(String(itemIndex));
                    return { swatchGroup: null, node: (
                        <View
                            ref={rowAnchorRef}
                            key={item.id}
                            testID={`${optionTestID}:scroll-frame`}
                            onPointerEnter={Platform.OS === 'web' ? (event: unknown) => {
                                // Touch has no hover: a tap opens the submenu through the press path.
                                if (readPointerType(event) === 'touch' || item.disabled) return;
                                props.onSelectionChange(itemIndex);
                                handleHoverItem();
                            } : undefined}
                            {...(scrollFrameLayout ? { onLayout: scrollFrameLayout } : {})}
                        >
                            {itemNode}
                        </View>
                    ) };
                });

                return (
                    <View key={category.id}>
                        {showCategoryTitles && category.title.trim().length > 0 ? (
                            <Eyebrow style={styles.categoryTitle}>
                                {category.title}
                            </Eyebrow>
                        ) : null}
                        {groupSwatchRuns(categoryItems, styles.swatchRow)}
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
