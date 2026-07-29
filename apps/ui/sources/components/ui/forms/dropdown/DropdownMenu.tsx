import * as React from 'react';
import { Platform, View, ViewStyle, StyleProp, TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Popover, type PopoverPlacement } from '@/components/ui/popover';
import { FloatingOverlay, type FloatingOverlayArrow } from '@/components/ui/overlays/FloatingOverlay';
import { t } from '@/text';
import type { SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { SelectableMenuResults } from '@/components/ui/forms/dropdown/SelectableMenuResults';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { useSelectableMenu, CREATE_ITEM_ID } from '@/components/ui/forms/dropdown/useSelectableMenu';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { TextInput } from '@/components/ui/text/Text';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';


export type DropdownMenuItem = Readonly<{
    id: string;
    testID?: string;
    title: string;
    subtitle?: string;
    accessibilityLabel?: string;
    category?: string;
    icon?: React.ReactNode;
    shortcut?: string;
    rightElement?: React.ReactNode;
    rowContainerStyle?: StyleProp<ViewStyle>;
    disabled?: boolean;
    submenu?: DropdownMenuSubmenu;
}>;

export type DropdownMenuSubmenu = Readonly<{
    items: ReadonlyArray<DropdownMenuItem>;
    placement?: PopoverPlacement;
    search?: boolean;
    searchPlaceholder?: string;
    emptyLabel?: string | null;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>;

export type DropdownMenuCreateItemDisplay = Readonly<{
    title: string;
    titleNode?: React.ReactNode;
    subtitle?: string;
    subtitleNode?: React.ReactNode;
    category?: string;
    icon?: React.ReactNode;
    rightElement?: React.ReactNode;
    disabled?: boolean;
    rowContainerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    subtitleStyle?: StyleProp<TextStyle>;
    leftGap?: number;
}>;

export type DropdownMenuItemTriggerConfig = Readonly<{
    title: string;
    icon?: React.ReactNode;
    /**
     * Fallback subtitle when no selected item subtitle is available, or when `showSelectedSubtitle` is false.
     */
    subtitle?: React.ReactNode;
    /**
     * When true (default), render the selected item's title in the right-side `detail`.
     */
    showSelectedDetail?: boolean;
    /**
     * When true (default), render the selected item's subtitle as the row subtitle.
     */
    showSelectedSubtitle?: boolean;
    /**
     * Optional: customize which detail string is shown (defaults to selected title).
     */
    detailFormatter?: (selectedItem: DropdownMenuItem | null) => string | null;
    /**
     * Optional: customize which subtitle is shown (defaults to selected subtitle or fallback subtitle).
     */
    subtitleFormatter?: (selectedItem: DropdownMenuItem | null) => React.ReactNode;
    /**
     * Pass-through props for the underlying `Item` trigger (excluding computed fields).
     */
    itemProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'detail' | 'icon' | 'rightElement' | 'onPress' | 'showChevron' | 'selected'>
    >;
}>;

export type DropdownMenuProps = Readonly<{
    testID?: string;
    /**
     * The trigger element.
     * Prefer the render-prop form so DropdownMenu can provide a consistent `toggle()` helper.
     * A ref will be attached internally for anchoring (the trigger is rendered inside that host).
     */
    trigger?:
        | React.ReactNode
        | ((props: Readonly<{
            open: boolean;
            toggle: () => void;
            openMenu: () => void;
            closeMenu: () => void;
            selectedItem: DropdownMenuItem | null;
        }>) => React.ReactNode);
    /**
     * Convenience: render a standardized `Item`-style trigger. This is recommended for settings-style
     * select rows so the selected label and description are visible without opening the menu.
     */
    itemTrigger?: DropdownMenuItemTriggerConfig;
    open: boolean;
    onOpenChange: (next: boolean) => void;

    items: ReadonlyArray<DropdownMenuItem>;
    onSelect: (itemId: string) => void;
    /** When false, selecting an item does not close the popover (useful for multi-select menus). */
    closeOnSelect?: boolean;
    /**
     * Optional: the currently-selected item ID. Used for initial keyboard highlight.
     * If it points to a disabled item, it is ignored.
     */
    selectedId?: string | null;

    /**
     * Visual style of rows:
     * - slim: compact action-list feel
     * - default: standard app row
     * - selectable: CommandPalette-style (hover/selected borders)
     */
    variant?: SelectableRowVariant;
    /** When true, shows a search field and enables keyboard navigation on web. */
    search?: boolean;
    searchPlaceholder?: string;
    emptyLabel?: string | null;
    placement?: PopoverPlacement;
    /** Gap between the trigger and the menu (default 0 for dropdown feel). */
    gap?: number;
    maxHeightCap?: number;
    maxWidthCap?: number;
    /** Match the popover width to the trigger width in web portal mode (default true). */
    matchTriggerWidth?: boolean;
    popoverBoundaryRef?: React.RefObject<any> | null;
    /**
     * Optional: anchor the popover to an external ref instead of the internal trigger host.
     * Useful for context menus that open from right-click/long-press on a row.
     */
    popoverAnchorRef?: React.RefObject<any> | null;
    /**
     * Web-only: controls where the popover portal is mounted.
     * Defaults to Popover's behavior (which prefers the modal portal target when inside a modal).
     * Set to 'body' to allow menus to escape overflow-clipped modals.
     */
    popoverPortalWebTarget?: 'body' | 'modal' | 'boundary';
    overlayStyle?: ViewStyle;
    /** When true, category titles like "General" are rendered (default false). */
    showCategoryTitles?: boolean;
    /** Extra bottom padding under the results list (defaults to 0; uses menu padding when `search` is enabled). */
    resultsPaddingBottom?: number;
    /** Render rows using the app `Item` component for perfect icon/typography parity. */
    rowKind?: 'selectableRow' | 'item';
    /** Pass-through props for `rowKind="item"` menu rows (excluding computed fields). */
    itemRowProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'icon' | 'rightElement' | 'selected' | 'disabled' | 'showChevron' | 'showDivider' | 'onPress'>
    >;
    /**
     * When true, the menu can open with no highlighted row (native touch-first context menus).
     * This avoids the first item looking "selected" on open.
     */
    allowEmptySelection?: boolean;
    /**
     * Optional arrow pointing back to the anchor (recommended for context menus).
     * When `true`, uses a default size. The arrow placement follows the resolved popover placement.
     */
    overlayArrow?: boolean | Readonly<{ size?: number }>;
    /**
     * Optional portal alignment override for top/bottom placements (horizontal).
     * Defaults to Popover's behavior (and DropdownMenu's historical 'start').
     */
    popoverAnchorAlign?: 'start' | 'center' | 'end';
    /**
     * Optional portal alignment override for left/right placements (vertical).
     */
    popoverAnchorAlignVertical?: 'start' | 'center' | 'end';
    /**
     * Make the menu visually connect to the trigger (no gap; squared top corners; no top border).
     * Intended for "dropdown" inputs where the menu should feel like a single control.
     */
    connectToTrigger?: boolean;
    /**
     * When provided and the search query yields zero results, a synthetic "Add '{query}'" row is
     * shown. Selecting it (by tap or Enter) calls this callback with the trimmed query string.
     * Only meaningful when `search` is true.
     */
    onCreateItem?: ((query: string) => void) | null;
    /**
     * Optional: customize the synthetic create row ("Add ...") when `onCreateItem` is provided.
     * When omitted, a simple string label is used.
     */
    createItemDisplay?: ((query: string) => DropdownMenuCreateItemDisplay) | null;
}>;

export function DropdownMenu(props: DropdownMenuProps) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const anchorRef = React.useRef<View>(null);
    const resolvedAnchorRef = props.popoverAnchorRef ?? anchorRef;
    const [activeSubmenu, setActiveSubmenu] = React.useState<{
        itemId: string;
        anchorRef: React.RefObject<unknown>;
    } | null>(null);

    const rowVariant: SelectableRowVariant = props.variant ?? 'slim';
    const resolvedTriggerDensity = useResolvedItemDensity(props.itemTrigger?.itemProps?.density);
    const createItemDisplay = props.createItemDisplay ?? null;
    const matchTriggerWidth = props.matchTriggerWidth ?? true;
    const maxWidthCap = props.maxWidthCap ?? (matchTriggerWidth ? 1024 : 320);
    const emptyLabel = props.emptyLabel === undefined ? t('commandPalette.noCommandsFound') : props.emptyLabel;
    const contentPadding = rowVariant === 'slim' ? 12 : 16;
    const resultsPaddingBottom = typeof props.resultsPaddingBottom === 'number'
        ? props.resultsPaddingBottom
        : (props.search ? contentPadding : 0);
    const requestedPlacement = props.placement ?? 'auto-vertical';
    const edgePadding = React.useMemo(() => {
        // Popover `edgePadding` is implemented as container padding (transparent background).
        // For left/right menus this creates visible empty space above/below the overlay, which looks
        // like a "mystery bottom padding" on context menus. Disable edge padding for side placements.
        if (requestedPlacement === 'left' || requestedPlacement === 'right') return 0;

        // When the menu is meant to visually "connect" to the trigger, horizontal edge padding
        // creates an inset that makes the popover look misaligned. Keep vertical breathing room.
        if (props.connectToTrigger || matchTriggerWidth) return { vertical: 8, horizontal: 0 } as const;
        return { vertical: 8, horizontal: 8 } as const;
    }, [matchTriggerWidth, props.connectToTrigger, requestedPlacement]);

    const selectableItems = React.useMemo((): SelectableMenuItem[] => {
        return props.items.map((item) => {
            const hasSubmenu = Boolean(item.submenu && item.submenu.items.length > 0);
            return {
                id: item.id,
                testID: item.testID,
                title: item.title,
                subtitle: item.subtitle,
                accessibilityLabel: item.accessibilityLabel,
                category: item.category,
                disabled: item.disabled,
                left: item.icon ?? null,
                rowContainerStyle: item.rowContainerStyle,
                right: item.rightElement
                    ? item.rightElement
                    : hasSubmenu
                        ? <Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />
                        : item.shortcut
                            ? <KeyHint label={item.shortcut} />
                            : null,
                hasSubmenu,
            };
        });
    }, [props.items, theme.colors.text.secondary]);

    const closeOnSelect = props.closeOnSelect !== false;
    const onRequestClose = React.useCallback(() => props.onOpenChange(false), [props]);
    const schedule = React.useCallback((cb: () => void) => {
        // Opening an overlay on the same click can sometimes immediately trigger a backdrop close
        // (especially on web). Deferring by one tick ensures the opening press completes first.
        // Note: some runtimes can throttle or suppress `requestAnimationFrame` (background tabs,
        // headless automation, etc). Always also schedule a timeout fallback so the menu can open
        // even if rAF never fires.
        let fired = false;
        const runOnce = () => {
            if (fired) return;
            fired = true;
            cb();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(runOnce);
        }
        setTimeout(runOnce, 0);
    }, []);
    const openMenu = React.useCallback(() => {
        schedule(() => props.onOpenChange(true));
    }, [props, schedule]);
    const closeMenu = React.useCallback(() => props.onOpenChange(false), [props]);
    const isSubmenuAnchorReady = React.useCallback((itemAnchorRef: React.RefObject<unknown>) => {
        const current = itemAnchorRef.current as { getBoundingClientRect?: () => { width?: number; height?: number } } | null;
        if (!current) return false;
        if (Platform.OS !== 'web') return true;
        if (typeof current.getBoundingClientRect !== 'function') return true;
        try {
            const rect = current.getBoundingClientRect();
            return Number.isFinite(rect?.width) && Number.isFinite(rect?.height) && (rect.width ?? 0) > 0 && (rect.height ?? 0) > 0;
        } catch {
            return false;
        }
    }, []);
    const toggle = React.useCallback(() => {
        if (props.open) {
            props.onOpenChange(false);
            return;
        }
        openMenu();
    }, [openMenu, props]);

    const selectedItemForTrigger = React.useMemo((): DropdownMenuItem | null => {
        const selectedId = typeof props.selectedId === 'string' ? props.selectedId.trim() : '';
        if (!selectedId) return null;
        const found = props.items.find((it) => it.id === selectedId) ?? null;
        if (!found || found.disabled) return null;
        return found;
    }, [props.items, props.selectedId]);
    const activeSubmenuItem = React.useMemo((): DropdownMenuItem | null => {
        if (!activeSubmenu) return null;
        return props.items.find((item) => item.id === activeSubmenu.itemId) ?? null;
    }, [activeSubmenu, props.items]);
    React.useEffect(() => {
        if (!props.open && activeSubmenu) {
            setActiveSubmenu(null);
        }
    }, [activeSubmenu, props.open]);

    const triggerNode = React.useMemo(() => {
        if (props.itemTrigger) {
            const cfg = props.itemTrigger;
            const showSelectedDetail = cfg.showSelectedDetail !== false;
            const showSelectedSubtitle = cfg.showSelectedSubtitle !== false;
            const detail =
                showSelectedDetail
                    ? (cfg.detailFormatter
                        ? cfg.detailFormatter(selectedItemForTrigger)
                        : (selectedItemForTrigger?.title ?? null))
                    : null;
            const subtitle =
                cfg.subtitleFormatter
                    ? cfg.subtitleFormatter(selectedItemForTrigger)
                    : (showSelectedSubtitle ? (selectedItemForTrigger?.subtitle ?? cfg.subtitle ?? null) : (cfg.subtitle ?? null));

            return (
                <Item
                    title={cfg.title}
                    subtitle={subtitle ?? undefined}
                    icon={cfg.icon}
                    detail={undefined}
                    rightElement={renderDropdownItemTriggerRightElement({
                        detail,
                        open: props.open,
                        detailColor: theme.colors.text.secondary,
                        chevronColor: theme.colors.text.secondary,
                        detailDensity: resolvedTriggerDensity,
                    })}
                    onPress={toggle}
                    showChevron={false}
                    selected={false}
                    {...(cfg.itemProps ?? {})}
                    webRole={cfg.itemProps?.webRole ?? 'button'}
                    density={resolvedTriggerDensity}
                />
            );
        }

        if (typeof props.trigger === 'function') {
            return props.trigger({
                open: props.open,
                toggle,
                openMenu,
                closeMenu,
                selectedItem: selectedItemForTrigger,
            });
        }
        return props.trigger;
    }, [closeMenu, openMenu, props.itemTrigger, props.open, props.trigger, resolvedTriggerDensity, selectedItemForTrigger, theme.colors.text.secondary, toggle]);

    const {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex,
    } = useSelectableMenu({
        items: selectableItems,
        onRequestClose,
        initialSelectedId: props.selectedId ?? null,
        onCreateItem: props.onCreateItem ?? null,
        allowEmptySelection: props.allowEmptySelection ?? false,
        createItemFactory: createItemDisplay
            ? ((query) => {
                const display = createItemDisplay(query);
                return {
                    title: display.title,
                    titleNode: display.titleNode,
                    subtitle: display.subtitle,
                    subtitleNode: display.subtitleNode,
                    category: display.category,
                    left: display.icon ?? null,
                    right: display.rightElement ?? null,
                    disabled: display.disabled,
                    rowContainerStyle: display.rowContainerStyle,
                    rowTitleStyle: display.titleStyle,
                    rowSubtitleStyle: display.subtitleStyle,
                    leftGap: display.leftGap,
                };
            })
            : null,
    });

    const resultScroll = useScrollRectIntoViewRegistry({
        activeKey: selectedIndex >= 0 ? String(selectedIndex) : null,
        padding: 8,
        animated: !reducedMotion,
    });

    const handleCreate = React.useCallback(() => {
        const query = searchQuery.trim();
        if (!query || !props.onCreateItem) return;
        props.onOpenChange(false);
        props.onCreateItem(query);
    }, [props, searchQuery]);

    const handleKeyDown = React.useCallback((e: any) => {
        if (Platform.OS !== 'web') return;
        const key = e?.nativeEvent?.key;
        if (typeof key !== 'string') return;
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        handleKeyPress(key, (item) => {
            if (item.id === CREATE_ITEM_ID) {
                handleCreate();
                return;
            }
            if (item.hasSubmenu) return;
            if (closeOnSelect) props.onOpenChange(false);
            props.onSelect(item.id);
        });
    }, [closeOnSelect, handleCreate, handleKeyPress, props]);
    const handleOpenSubmenu = React.useCallback((itemId: string, itemAnchorRef: React.RefObject<unknown>) => {
        const item = props.items.find((candidate) => candidate.id === itemId);
        if (!item?.submenu || item.disabled) return;
        const openFromAnchor = () => {
            setActiveSubmenu({ itemId, anchorRef: itemAnchorRef });
        };
        if (isSubmenuAnchorReady(itemAnchorRef)) {
            openFromAnchor();
            return;
        }
        const retryWhenAnchorSettles = (attempt: number) => {
            if (isSubmenuAnchorReady(itemAnchorRef)) {
                openFromAnchor();
                return;
            }
            if (attempt >= 10) return;
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => retryWhenAnchorSettles(attempt + 1));
                return;
            }
            setTimeout(() => retryWhenAnchorSettles(attempt + 1), 0);
        };
        retryWhenAnchorSettles(0);
    }, [isSubmenuAnchorReady, props.items]);
    const handlePressMenuItem = React.useCallback((item: SelectableMenuItem) => {
        if (item.id === CREATE_ITEM_ID) {
            handleCreate();
            return;
        }
        if (item.hasSubmenu) return;
        if (closeOnSelect) props.onOpenChange(false);
        props.onSelect(item.id);
    }, [closeOnSelect, handleCreate, props]);
    const handleSubmenuSelect = React.useCallback((itemId: string) => {
        setActiveSubmenu(null);
        if (closeOnSelect) props.onOpenChange(false);
        props.onSelect(itemId);
    }, [closeOnSelect, props]);

    const overlayArrowCfg = React.useMemo((): Omit<Exclude<FloatingOverlayArrow, boolean>, 'placement'> | null => {
        const arrow = props.overlayArrow;
        if (!arrow) return null;
        if (arrow === true) return { size: 12 } as const;
        return { size: typeof arrow.size === 'number' ? arrow.size : 12 } as const;
    }, [props.overlayArrow]);

    return (
        <View
            ref={anchorRef}
            testID={props.testID}
            // Ensure this wrapper exists in the native hierarchy so `measureInWindow` is reliable.
            // Without this, RN can "collapse" the View and measurement can return 0x0, causing
            // dropdowns to overlap their trigger (notably on iOS).
            collapsable={false}
            style={{ position: 'relative' }}
        >
            {triggerNode}
            {props.open ? (
                <Popover
                    open={props.open}
                    anchorRef={resolvedAnchorRef}
                    placement={requestedPlacement}
                    gap={props.gap ?? 0}
                    maxHeightCap={props.maxHeightCap ?? 320}
                    maxWidthCap={maxWidthCap}
                    edgePadding={edgePadding}
                    portal={{
                        web: props.popoverPortalWebTarget ? { target: props.popoverPortalWebTarget } : true,
                        native: true,
                        matchAnchorWidth: matchTriggerWidth,
                        anchorAlign: props.popoverAnchorAlign,
                        anchorAlignVertical: props.popoverAnchorAlignVertical ?? 'start',
                    }}
                    boundaryRef={props.popoverBoundaryRef}
                    onRequestClose={onRequestClose}
                >
                    {({ maxHeight, maxWidth, placement }) => (
                        <FloatingOverlay
                            maxHeight={maxHeight}
                            edgeFades={{ top: true, bottom: true }}
                            edgeIndicators={{ size: 14, opacity: 0.35 }}
                            arrow={overlayArrowCfg ? { placement, size: overlayArrowCfg.size } : false}
                            surfaceChrome="theme"
                            scrollViewRef={resultScroll.scrollRef}
                            onScrollViewLayout={resultScroll.onViewportLayout}
                            onScrollViewContentSizeChange={resultScroll.onContentSizeChange}
                            onScrollViewScroll={resultScroll.onScroll}
                            containerStyle={[
                                props.connectToTrigger
                                    ? (placement === 'top'
                                        ? ({
                                            borderBottomLeftRadius: 0,
                                            borderBottomRightRadius: 0,
                                            marginBottom: -1,
                                            borderBottomWidth: 0,
                                        } as any)
                                        : ({
                                            borderTopLeftRadius: 0,
                                            borderTopRightRadius: 0,
                                            marginTop: -1,
                                            borderTopWidth: 0,
                                        } as any))
                                    : null,
                                props.overlayStyle ?? null,
                            ]}
                        >
                            {props.search ? (
                                <View style={{
                                    paddingHorizontal: contentPadding,
                                    paddingTop: contentPadding,
                                    paddingBottom: rowVariant === 'slim' ? 4 : 8,
                                }}>
                                    <TextInput
                                        ref={inputRef as any}
                                        value={searchQuery}
                                        onChangeText={handleSearchChange}
                                        placeholder={props.searchPlaceholder ?? t('commandPalette.placeholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        autoFocus={false}
                                        autoCorrect={false}
                                        autoCapitalize="none"
                                        onKeyPress={handleKeyDown}
                                        style={{
                                            borderRadius: rowVariant === 'slim' ? 8 : 10,
                                            borderWidth: 1,
                                            borderColor: theme.colors.border.default,
                                            paddingHorizontal: rowVariant === 'slim' ? 10 : 12,
                                            paddingVertical: rowVariant === 'slim' ? 8 : 10,
                                            fontSize: rowVariant === 'slim' ? 14 : 15,
                                            color: theme.colors.text.primary,
                                        }}
                                    />
                                </View>
                            ) : null}

                            <View style={{ paddingBottom: resultsPaddingBottom }}>
                                <SelectableMenuResults
                                    categories={filteredCategories}
                                    selectedIndex={selectedIndex}
                                    onSelectionChange={setSelectedIndex}
                                    onPressItem={(item) => {
                                        handlePressMenuItem(item);
                                    }}
                                    onOpenSubmenu={handleOpenSubmenu}
                                    rowVariant={rowVariant}
                                    emptyLabel={emptyLabel}
                                    showCategoryTitles={props.showCategoryTitles ?? false}
                                    rowKind={props.rowKind}
                                    itemProps={props.itemRowProps}
                                    registerItemLayout={resultScroll.registerItemLayout}
                                />
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
            {props.open && activeSubmenu && activeSubmenuItem?.submenu ? (
                <DropdownMenu
                    open={true}
                    onOpenChange={(next) => {
                        if (!next) setActiveSubmenu(null);
                    }}
                    items={activeSubmenuItem.submenu.items}
                    onSelect={handleSubmenuSelect}
                    closeOnSelect={false}
                    trigger={null}
                    placement={activeSubmenuItem.submenu.placement ?? 'auto-horizontal'}
                    gap={4}
                    maxHeightCap={activeSubmenuItem.submenu.maxHeightCap ?? props.maxHeightCap}
                    maxWidthCap={activeSubmenuItem.submenu.maxWidthCap ?? props.maxWidthCap}
                    matchTriggerWidth={false}
                    popoverAnchorRef={activeSubmenu.anchorRef}
                    popoverBoundaryRef={null}
                    popoverPortalWebTarget="body"
                    search={activeSubmenuItem.submenu.search}
                    searchPlaceholder={activeSubmenuItem.submenu.searchPlaceholder}
                    emptyLabel={activeSubmenuItem.submenu.emptyLabel}
                    variant={props.variant}
                    rowKind={props.rowKind}
                    itemRowProps={props.itemRowProps}
                    showCategoryTitles={props.showCategoryTitles}
                    allowEmptySelection={props.allowEmptySelection}
                />
            ) : null}
        </View>
    );
}
