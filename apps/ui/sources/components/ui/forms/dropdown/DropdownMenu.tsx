import * as React from 'react';
import { Platform, View, ViewStyle, StyleProp, TextStyle, type AccessibilityState, type LayoutChangeEvent } from 'react-native';
import { usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { useUnistyles } from 'react-native-unistyles';

import { Popover, type PopoverAnchor, type PopoverPlacement, type PopoverRenderProps } from '@/components/ui/popover';
import { POPOVER_PREFERRED_ROOM_PX } from '@/components/ui/popover/popoverPreferredRoom';
import { FloatingOverlay, type FloatingOverlayArrow } from '@/components/ui/overlays/FloatingOverlay';
import { t } from '@/text';
import type { SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { SelectableMenuResults, type SelectableMenuResultsHandle } from '@/components/ui/forms/dropdown/SelectableMenuResults';
import type { MenuItemSource, SelectableMenuItemSource, SelectableMenuCategoryDecorations, SelectableMenuItem, SelectableMenuSwatch } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { useSelectableMenu, CREATE_ITEM_ID } from '@/components/ui/forms/dropdown/useSelectableMenu';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { useScrollRectIntoViewRegistry } from '@/components/ui/scroll/useScrollRectIntoView';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Icon } from '@/components/ui/icons/Icon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { iconMatchedSpinnerSize } from '@happier-dev/plugin-ui/presentation';
import { SUBMENU_POPOVER_GAP_PX, useSubmenuHoverIntent } from '@/components/ui/forms/dropdown/useSubmenuHoverIntent';

const DROPDOWN_ACTION_FRAME_FALLBACK_MS = 100;



/** A menu that is not tied to its trigger's width reads as a menu, not a sheet: this is its widest. */
export const DROPDOWN_MENU_MAX_WIDTH_PX = 320;

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
    /** An irreversible operation (delete, clear): the row's title takes the danger tone. */
    destructive?: boolean;
    /** Current choice state, independent of keyboard highlight. */
    checked?: boolean;
    /**
     * One of several independent on/off choices (a menu's filters): a box that checks, announced as a checkbox,
     * so siblings that are on together never read as one radio choice.
     */
    multiSelect?: boolean;
    submenu?: DropdownMenuSubmenu;
    /** Present the item as a round colour choice instead of a text row (`title` stays its label). */
    swatch?: SelectableMenuSwatch;
    /**
     * The item finishes its own work before the menu closes (it loads something first): selecting it
     * leaves this menu and its parents open; the owner closes them when it is ready.
     */
    keepMenuOpen?: boolean;
    /** The item's work is under way: its trailing slot shows the app's activity spinner. */
    loading?: boolean;
}>;

export type DropdownMenuSelection = Readonly<{ anchor: PopoverAnchor }>;

export type DropdownMenuSubmenu = Readonly<{
    items: ReadonlyArray<DropdownMenuItem>;
    placement?: PopoverPlacement;
    search?: boolean;
    searchPlaceholder?: string;
    emptyLabel?: string | null;
    maxHeightCap?: number;
    maxWidthCap?: number;
    /** Intent signal: the submenu is opening (preload what its items will need). Hover may repeat it. */
    onOpen?: () => void;
    /** Draw this submenu's category titles (a chooser titled by what it acts on), whatever its parent does. */
    showCategoryTitles?: boolean;
    /** Draw a hairline between this submenu's groups ("Sections" | New section…, Back to project). */
    separateCategories?: boolean;
    /**
     * The submenu's own name when it differs from the row that opens it ("Move “Client work” to" under "Move to
     * folder…"): its accessible name, and its title where a phone presents it as a sheet.
     */
    title?: string;
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
     * Page field only: how the bordered value box presents the current choice — a leading mark, a
     * quieter second half, a quieter value, and the invalid border for a value that no longer resolves.
     */
    field?: Readonly<{ leading?: React.ReactNode; secondary?: string | null; quietValue?: boolean; invalid?: boolean }>;
    /** Page field only: what an empty choice asks for when the row knows its noun ("Choose the session"). */
    placeholder?: string;
    /**
     * Pass-through props for the underlying `Item` trigger (excluding computed fields).
     */
    itemProps?: Partial<
        Omit<ItemProps, 'title' | 'subtitle' | 'detail' | 'icon' | 'rightElement' | 'onPress' | 'showChevron' | 'selected'>
    >;
}>;

export type DropdownMenuProps = Readonly<{
    testID?: string;
    header?: React.ReactNode;
    footer?: React.ReactNode | ((selection: DropdownMenuSelection) => React.ReactNode);
    /** Replace rows with a domain chooser inside this menu's existing overlay and dismissal lifecycle. */
    renderContent?: (layout: PopoverRenderProps) => React.ReactNode;
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
    /** A large admitted inventory supplies lightweight metadata and materializes only demanded rows. */
    itemSource?: MenuItemSource<DropdownMenuItem>;
    /**
     * `selection.anchor` is what the menu hung from (its trigger, or `popoverAnchor`): an item that opens a
     * surface (Share…) hangs that surface from the same control once the menu has closed.
     */
    onSelect: (itemId: string, selection?: DropdownMenuSelection) => void;
    /** Destination row decoration defers web activation until press, leaving mouse-down available for dragging. */
    wrapItem?: (item: SelectableMenuItem, content: React.ReactNode) => React.ReactNode;
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
    /** What an empty menu says: a sentence, or a composed empty state; `null` draws nothing. */
    emptyLabel?: React.ReactNode;
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
     * Optional measured anchor supplied directly to Popover. Rect anchors are useful for menus
     * opened from a press inside a much larger or partially clipped trigger.
     */
    popoverAnchor?: PopoverAnchor;
    /**
     * Web-only: controls where the popover portal is mounted.
     * Defaults to Popover's behavior (which prefers the modal portal target when inside a modal).
     * Set to 'body' to allow menus to escape overflow-clipped modals.
     */
    popoverPortalWebTarget?: 'body' | 'modal' | 'boundary';
    /** On a phone, present the menu as the shared bottom sheet (named by `popoverAccessibilityLabel`). */
    popoverPhonePresentation?: 'sheet';
    popoverAccessibilityLabel?: string;
    /** The phone sheet's line under its title. */
    popoverSheetSubtitle?: string;
    overlayStyle?: ViewStyle;
    /** When true, category titles like "General" are rendered (default false). */
    showCategoryTitles?: boolean;
    /** Draw a hairline between untitled categories (choices, then operations). */
    separateCategories?: boolean;
    /** Per titled category (keyed by its title): an identity mark beside the title and one quiet note under its rows. */
    categoryDecorations?: SelectableMenuCategoryDecorations;
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
    /** Set by a parent menu on its submenu: keyboard Left from the submenu returns to the parent. */
    onKeyboardBack?: () => void;
    /** Set by a parent menu on its submenu: the pointer entered or left this submenu's surface. */
    onSurfacePointerChange?: (inside: boolean, event: unknown) => void;
}>;

type DropdownTriggerAccessibilityProps = Readonly<{
    expanded?: boolean;
    accessibilityState?: AccessibilityState;
    'aria-expanded'?: boolean;
}>;

/**
 * A sheet titled by `title` drops the category heading that only repeats it; the category's rows stay.
 * Only while no titled group is drawn above it: after one, the heading is what keeps its rows out of that group.
 */
export function untitleSheetCategories<Category extends Readonly<{ title: string; items?: readonly unknown[] }>>(
    categories: readonly Category[],
    title: string | undefined,
): readonly Category[] {
    if (!title) return categories;
    let titledAbove = false;
    return categories.map((category) => {
        const drawn = category.items === undefined || category.items.length > 0;
        if (category.title === title && !titledAbove) return { ...category, title: '' };
        if (drawn && category.title.trim().length > 0) titledAbove = true;
        return category;
    });
}

function withExpandedTriggerState(trigger: React.ReactNode, open: boolean): React.ReactNode {
    if (!React.isValidElement<DropdownTriggerAccessibilityProps>(trigger)) return trigger;

    if (typeof trigger.type === 'string' && trigger.type === trigger.type.toLowerCase()) {
        return React.cloneElement(trigger, { 'aria-expanded': open });
    }

    return React.cloneElement(trigger, {
        expanded: open,
        accessibilityState: {
            ...trigger.props.accessibilityState,
            expanded: open,
        },
        'aria-expanded': open,
    });
}

const NO_SELECTABLE_ITEMS: ReadonlyArray<SelectableMenuItem> = Object.freeze([]);
/** In a sheet a row's submenu opens by press only (hover would push it under the pointer). */
const IGNORE_SHEET_HOVER = () => {};

export function DropdownMenu(props: DropdownMenuProps) {
    const { theme } = useUnistyles();
    // Keycaps name a key: with no hardware keyboard they only take width from the row.
    const hasHardwareKeyboard = useHardwareKeyboard();
    const reducedMotion = useReducedMotionPreference();
    const anchorRef = React.useRef<View>(null);
    const resolvedAnchorRef = props.popoverAnchorRef ?? anchorRef;
    const selection = React.useMemo<DropdownMenuSelection>(() => ({ anchor: props.popoverAnchor ?? { kind: 'view', ref: resolvedAnchorRef } }),
        [props.popoverAnchor, resolvedAnchorRef]);
    const submenuAnchorsRef = React.useRef(new Map<string, React.RefObject<unknown>>());
    const [activeSubmenu, setActiveSubmenu] = React.useState<{
        itemId: string;
        anchorRef: React.RefObject<unknown>;
    } | null>(null);
    const menuItems = props.itemSource?.items ?? props.items;
    const findMenuItem = React.useCallback((id: string) => {
        if (!props.itemSource) return menuItems.find((item) => item.id === id);
        const index = props.itemSource.indexById.get(id);
        return index === undefined ? undefined : props.itemSource.getItem(index);
    }, [menuItems, props.itemSource]);

    const rowVariant: SelectableRowVariant = props.variant ?? 'slim';
    const resolvedTriggerDensity = useResolvedItemDensity(props.itemTrigger?.itemProps?.density);
    const createItemDisplay = props.createItemDisplay ?? null;
    const matchTriggerWidth = props.matchTriggerWidth ?? true;
    const maxWidthCap = props.maxWidthCap ?? (matchTriggerWidth ? 1024 : DROPDOWN_MENU_MAX_WIDTH_PX);
    // A menu is as tall as its content and the window allow (the Popover clamps to the room on its
    // side); it never cuts a list off at a fixed height. A caller's explicit cap still wins.
    const { height: windowHeight } = usePresentationWindowDimensions();
    const maxHeightCap = props.maxHeightCap ?? windowHeight;
    const placementMinSpace = props.maxHeightCap ?? POPOVER_PREFERRED_ROOM_PX;
    const emptyLabel = props.emptyLabel === undefined ? t('common.noMatches') : props.emptyLabel;
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

    const toSelectableItem = (item: DropdownMenuItem): SelectableMenuItem => {
            const hasSubmenu = Boolean(item.submenu && item.submenu.items.length > 0);
            return {
                id: item.id,
                testID: item.testID,
                title: item.title,
                subtitle: item.subtitle,
                accessibilityLabel: item.accessibilityLabel,
                category: item.category,
                disabled: item.disabled,
                checked: item.checked,
                multiSelect: item.multiSelect,
                swatch: item.swatch,
                left: item.icon ?? null,
                rowContainerStyle: item.rowContainerStyle,
                ...(item.destructive ? { rowTitleStyle: { color: theme.colors.state.danger.foreground } } : {}),
                right: item.loading
                    ? <ActivitySpinner size={iconMatchedSpinnerSize(16)} color={theme.colors.text.secondary} />
                    : item.rightElement
                    ? item.rightElement
                    : hasSubmenu
                        ? <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
                        : item.shortcut && hasHardwareKeyboard
                            ? <KeyHint label={item.shortcut} />
                            : null,
                hasSubmenu,
            };
    };
    // A shut menu is a trigger: its rows are built when it opens (a row menu per list row would otherwise
    // build and group every row's items at rest). The trigger reads the raw items only for the selected one.
    const selectableItems = React.useMemo(() => props.open ? menuItems.map(toSelectableItem) : NO_SELECTABLE_ITEMS,
        [hasHardwareKeyboard, menuItems, props.open, theme.colors.state.danger.foreground, theme.colors.text.secondary]);
    const selectableItemSource: SelectableMenuItemSource | undefined = props.open && props.itemSource ? {
        items: selectableItems,
        indexById: props.itemSource.indexById,
        getItem(index) {
            const item = props.itemSource?.getItem(index);
            return item ? toSelectableItem(item) : undefined;
        },
    } : undefined;

    const closeOnSelect = props.closeOnSelect !== false;
    const onRequestClose = React.useCallback(() => props.onOpenChange(false), [props]);
    const requestPopoverCloseRef = React.useRef<PopoverRenderProps['requestClose']>(onRequestClose);
    const schedule = React.useCallback((cb: () => void, fallbackDelayMs = 0) => {
        // Let the current press and any menu teardown finish before opening or committing.
        // Note: some runtimes can throttle or suppress `requestAnimationFrame` (background tabs,
        // headless automation, etc). Always also schedule a timeout fallback so the menu can open
        // even if rAF never fires. Closing actions delay that fallback so it cannot beat a
        // healthy foreground frame and launch the next overlay before teardown commits.
        let fired = false;
        const runOnce = () => {
            if (fired) return;
            fired = true;
            cb();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(runOnce);
        }
        setTimeout(runOnce, fallbackDelayMs);
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
        const found = findMenuItem(selectedId) ?? null;
        if (!found || found.disabled) return null;
        return found;
    }, [findMenuItem, props.selectedId]);
    const activeSubmenuItem = React.useMemo((): DropdownMenuItem | null => {
        if (!activeSubmenu) return null;
        return findMenuItem(activeSubmenu.itemId) ?? null;
    }, [activeSubmenu, findMenuItem]);
    React.useEffect(() => {
        if (!props.open && activeSubmenu) {
            setActiveSubmenu(null);
        }
    }, [activeSubmenu, props.open]);

    // Configuration selects keep one bordered field treatment at every width. Item's measured
    // adaptive layout moves the field below the label when the row has no room beside it.
    // Menus, sheets and grouped lists retain their grouped trigger.
    const isPagePresentation = useListPresentation() === 'page';
    const pageTrigger = isPagePresentation ? 'field' : null;
    const fieldInvalid = props.itemTrigger?.field?.invalid === true;
    const fieldColors = React.useMemo(
        () => (pageTrigger === 'field' ? resolveFieldBoxColors(theme, fieldInvalid ? 'invalid' : 'idle') : undefined),
        [fieldInvalid, pageTrigger, theme],
    );
    // A page field names whatever is stored, including an option that can no longer be chosen; only
    // an empty selection asks for a choice.
    const pageSelectedItem = React.useMemo((): DropdownMenuItem | null => {
        if (!pageTrigger) return null;
        const selectedId = typeof props.selectedId === 'string' ? props.selectedId.trim() : '';
        if (!selectedId) return null;
        return findMenuItem(selectedId) ?? null;
    }, [pageTrigger, findMenuItem, props.selectedId]);
    const triggerNode = React.useMemo(() => {
        if (props.itemTrigger) {
            const cfg = props.itemTrigger;
            const showSelectedDetail = cfg.showSelectedDetail !== false;
            const showSelectedSubtitle = cfg.showSelectedSubtitle !== false;
            const formattedDetail = showSelectedDetail
                ? (cfg.detailFormatter
                    ? cfg.detailFormatter(selectedItemForTrigger)
                    : (selectedItemForTrigger?.title ?? null))
                : null;
            // A page field always shows the value; `showSelectedDetail: false` only means the grouped
            // row carries it in its description instead.
            const detail = pageTrigger ? (formattedDetail || pageSelectedItem?.title || null) : formattedDetail;
            const resolvedSubtitle =
                cfg.subtitleFormatter
                    ? cfg.subtitleFormatter(selectedItemForTrigger)
                    : (showSelectedSubtitle ? (selectedItemForTrigger?.subtitle ?? cfg.subtitle ?? null) : (cfg.subtitle ?? null));
            // The field shows the value, so a description that only restates it is dropped.
            const subtitle = pageTrigger && detail && resolvedSubtitle === detail ? null : resolvedSubtitle;

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
                        field: fieldColors,
                        placeholder: pageTrigger ? cfg.placeholder ?? t('common.choose') : undefined,
                        placeholderColor: theme.colors.input.placeholder,
                        // A field its row places under the label spans the row, like every stacked control.
                        fieldSpan: cfg.itemProps?.accessoryLayout === 'stacked' ? 'row' : pageTrigger ? 'column' : 'content',
                        ...(pageTrigger === 'field' && cfg.field ? {
                            leading: cfg.field.leading,
                            secondary: cfg.field.secondary ?? null,
                            quietValue: cfg.field.quietValue === true,
                            secondaryColor: theme.colors.text.tertiary,
                            quietValueColor: theme.colors.text.secondary,
                        } : {}),
                    })}
                    // Page triggers measure the row (R9): a narrow row puts the value under the
                    // label rather than pushing it off the side of the screen.
                    accessoryLayout={pageTrigger ? 'adaptive' : undefined}
                    fieldAccessory={pageTrigger ? true : undefined}
                    onPress={toggle}
                    showChevron={false}
                    selected={false}
                    {...(cfg.itemProps ?? {})}
                    accessibilityExpanded={props.open}
                    webRole={cfg.itemProps?.webRole ?? 'button'}
                    density={resolvedTriggerDensity}
                />
            );
        }

        if (typeof props.trigger === 'function') {
            return withExpandedTriggerState(props.trigger({
                open: props.open,
                toggle,
                openMenu,
                closeMenu,
                selectedItem: selectedItemForTrigger,
            }), props.open);
        }
        return withExpandedTriggerState(props.trigger, props.open);
    }, [closeMenu, fieldColors, openMenu, pageSelectedItem, pageTrigger, props.itemTrigger, props.open, props.trigger, resolvedTriggerDensity, selectedItemForTrigger, theme.colors.input.placeholder, theme.colors.text.secondary, theme.colors.text.tertiary, toggle]);

    const resultsRef = React.useRef<SelectableMenuResultsHandle>(null);
    // The highlighted row scrolls into view only once the user moves it (or when it is the menu's current choice):
    // a menu that opens on its first row stays at its top, so its first heading is never scrolled under the fade.
    const [highlightMoved, setHighlightMoved] = React.useState(false);
    React.useEffect(() => { if (!props.open) setHighlightMoved(false); }, [props.open]);
    const searchable = props.search === true;
    // A searched menu keeps the height it opened at: narrowing to a few rows (or none) never shrinks the
    // overlay, so it neither jumps away from its trigger nor re-places itself while the person types.
    const [resultsMinHeight, setResultsMinHeight] = React.useState(0);
    React.useEffect(() => { if (!props.open) setResultsMinHeight(0); }, [props.open]);
    const onResultsLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        setResultsMinHeight((current) => (height > current ? height : current));
    }, []);
    const followKeyboardSelection = React.useCallback((index: number) => {
        setHighlightMoved(true);
        if (!searchable) resultsRef.current?.focusItem(index);
    }, [searchable]);
    const {
        searchQuery,
        selectedIndex,
        filteredCategories,
        allItems: filteredItems,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex,
    } = useSelectableMenu({
        items: selectableItems,
        itemSource: selectableItemSource,
        onRequestClose,
        open: props.open,
        initialSelectedId: props.selectedId ?? null,
        onCreateItem: props.onCreateItem ?? null,
        allowEmptySelection: props.allowEmptySelection ?? false,
        enableTypeahead: props.search !== true,
        onKeyboardSelectionChange: followKeyboardSelection,
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

    // The menu's results keep one identity per filter result, so its row structure is rebuilt only when they change.
    const sheetCategories = React.useMemo(
        () => untitleSheetCategories(filteredCategories, props.popoverAccessibilityLabel),
        [filteredCategories, props.popoverAccessibilityLabel],
    );
    const highlightedId = filteredItems[selectedIndex]?.id ?? null;
    // A pointer open highlights nothing on swatches until the person hovers or uses the keyboard.
    const [swatchHighlightVisible, setSwatchHighlightVisible] = React.useState(false);
    React.useEffect(() => {
        if (!props.open) setSwatchHighlightVisible(false);
    }, [props.open]);
    const handleResultsSelectionChange = React.useCallback((index: number) => {
        setSwatchHighlightVisible(true);
        setSelectedIndex(index);
    }, [setSelectedIndex]);

    const resultScroll = useScrollRectIntoViewRegistry({
        activeKey: highlightMoved || (highlightedId !== null && highlightedId === props.selectedId) ? highlightedId : null,
        padding: theme.space.s8,
        animated: !reducedMotion,
        // Revealed once per highlighted row: a long menu mounts rows as the person scrolls, and those layouts must
        // not pull them back to a highlight they scrolled away from.
        once: true,
    });

    const handleCreate = React.useCallback(() => {
        const query = searchQuery.trim();
        if (!query || !props.onCreateItem) return;
        requestPopoverCloseRef.current('selection');
        schedule(() => props.onCreateItem?.(query), DROPDOWN_ACTION_FRAME_FALLBACK_MS);
    }, [props, schedule, searchQuery]);
    const commitSelection = React.useCallback((itemId: string) => {
        if (!closeOnSelect || findMenuItem(itemId)?.keepMenuOpen) {
            props.onSelect(itemId, selection);
            return;
        }
        // Restore through the same owner as Escape, before the item's deferred action
        // can deliberately move focus into its own dialog or pane.
        requestPopoverCloseRef.current('selection');
        schedule(() => props.onSelect(itemId, selection), DROPDOWN_ACTION_FRAME_FALLBACK_MS);
    }, [closeOnSelect, findMenuItem, props, schedule, selection]);

    // Assigned once handleOpenSubmenu exists below; keyboard opening uses the pointer's own anchor.
    const handleOpenSubmenuRef = React.useRef<(itemId: string, anchorRef: React.RefObject<unknown>) => void>(() => undefined);
    const openSubmenuFromKeyboard = React.useCallback((itemId: string) => {
        const anchorRef = submenuAnchorsRef.current.get(itemId);
        if (anchorRef) handleOpenSubmenuRef.current(itemId, anchorRef);
    }, []);
    // Outside a swatch row, Right opens the highlighted submenu and Left returns to the parent menu.
    const handleSubmenuCrossKey = React.useCallback((key: string): boolean => {
        if (key === 'ArrowRight') {
            const item = filteredItems[selectedIndex];
            if (!item?.hasSubmenu || item.disabled) return false;
            openSubmenuFromKeyboard(item.id);
            return true;
        }
        if (key === 'ArrowLeft' && props.onKeyboardBack) {
            props.onKeyboardBack();
            return true;
        }
        return false;
    }, [filteredItems, openSubmenuFromKeyboard, props.onKeyboardBack, selectedIndex]);
    const handleKeyDown = React.useCallback((e: any) => {
        if (Platform.OS !== 'web') return;
        setSwatchHighlightVisible(true);
        const key = e?.nativeEvent?.key;
        if (typeof key !== 'string') return;
        // Search fields own ordinary typed text. An unsearched dropdown instead
        // delegates printable keys to the shared prefix-selection owner.
        if (props.search && !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'].includes(key)) return;
        const handled = handleKeyPress(key, (item) => {
            if (item.id === CREATE_ITEM_ID) {
                handleCreate();
                return;
            }
            if (item.hasSubmenu) {
                openSubmenuFromKeyboard(item.id);
                return;
            }
            commitSelection(item.id);
        }) || (!props.search && handleSubmenuCrossKey(key));
        if (!handled) return;
        e.preventDefault?.();
        e.stopPropagation?.();
    }, [commitSelection, handleCreate, handleKeyPress, handleSubmenuCrossKey, openSubmenuFromKeyboard, props.search]);
    const handleOpenSubmenu = React.useCallback((itemId: string, itemAnchorRef: React.RefObject<unknown>) => {
        const item = findMenuItem(itemId);
        if (!item?.submenu || item.disabled) return;
        item.submenu.onOpen?.();
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
    }, [findMenuItem, isSubmenuAnchorReady]);
    handleOpenSubmenuRef.current = handleOpenSubmenu;
    const closeActiveSubmenu = React.useCallback(() => setActiveSubmenu(null), []);
    const submenuHover = useSubmenuHoverIntent({
        activeItemId: activeSubmenu?.itemId ?? null,
        enabled: props.open,
        closeSubmenu: closeActiveSubmenu,
    });
    // The pointer rests on a row: the shared hover intent opens its submenu after a dwell, or closes
    // another open one after the grace period.
    const handleHoverItem = React.useCallback((item: SelectableMenuItem, anchorRef: React.RefObject<unknown>) => {
        const opensSubmenu = item.hasSubmenu === true && item.disabled !== true;
        submenuHover.hoverItem(item.id, opensSubmenu ? () => handleOpenSubmenu(item.id, anchorRef) : null);
    }, [handleOpenSubmenu, submenuHover]);
    const handleSubmenuSurfacePointerChange = submenuHover.surfacePointerChange;

    const handlePressMenuItem = React.useCallback((item: SelectableMenuItem) => {
        if (item.id === CREATE_ITEM_ID) {
            handleCreate();
            return;
        }
        if (item.hasSubmenu) return;
        commitSelection(item.id);
    }, [commitSelection, handleCreate]);
    const handleSubmenuSelect = React.useCallback((itemId: string) => {
        if (activeSubmenuItem?.submenu?.items.some((item) => item.id === itemId && item.keepMenuOpen)) {
            props.onSelect(itemId, selection);
            return;
        }
        setActiveSubmenu(null);
        commitSelection(itemId);
    }, [activeSubmenuItem, commitSelection, props, selection]);

    const overlayArrowCfg = React.useMemo((): Omit<Exclude<FloatingOverlayArrow, boolean>, 'placement'> | null => {
        const arrow = props.overlayArrow;
        if (!arrow) return null;
        if (arrow === true) return { size: 12 } as const;
        return { size: typeof arrow.size === 'number' ? arrow.size : 12 } as const;
    }, [props.overlayArrow]);

    const searchField = props.search ? (
        <View style={{
            paddingHorizontal: contentPadding,
            paddingTop: contentPadding,
            paddingBottom: rowVariant === 'slim' ? 4 : 8,
        }}>
            <CompactSearchField
                inputRef={inputRef}
                value={searchQuery}
                onChangeText={handleSearchChange}
                placeholder={props.searchPlaceholder ?? t('common.search')}
                onKeyPress={handleKeyDown}
            />
        </View>
    ) : null;

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
                    anchor={props.popoverAnchor}
                    autoFocusOnOpen
                    placement={requestedPlacement}
                    gap={props.gap ?? 0}
                    maxHeightCap={maxHeightCap}
                    placementMinSpace={placementMinSpace}
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
                    phonePresentation={props.popoverPhonePresentation}
                    accessibilityLabel={props.popoverAccessibilityLabel}
                    sheetSubtitle={props.popoverSheetSubtitle}
                    onRequestClose={onRequestClose}
                >
                    {({ maxHeight, maxWidth, placement, presentation, requestClose }) => {
                        requestPopoverCloseRef.current = requestClose;
                        return <>
                        {/* Pointer presence on this surface drives submenu hover intent (web pointers only). */}
                        <View
                            collapsable={false}
                            testID={props.onSurfacePointerChange ? 'dropdown-submenu-surface' : undefined}
                            // A sheet has no hover: its submenus push inside it and leave only by Back.
                            onPointerEnter={presentation !== 'sheet' && (Platform.OS === 'web' || props.onSurfacePointerChange) ? (event: unknown) => {
                                props.onSurfacePointerChange?.(true, event);
                            } : undefined}
                            onPointerLeave={presentation !== 'sheet' && (Platform.OS === 'web' || props.onSurfacePointerChange) ? (event: unknown) => {
                                props.onSurfacePointerChange?.(false, event);
                                // Leaving this menu for anywhere but its open submenu closes that submenu after the grace.
                                submenuHover.scheduleClose(event);
                            } : undefined}
                        >
                        <FloatingOverlay
                            // The search field stays pinned above the scrolling results, so a long list scrolled to
                            // its current choice never carries the field out of view.
                            header={props.header || props.search ? <>{props.header}{searchField}</> : undefined}
                            footer={typeof props.footer === 'function' ? props.footer(selection) : props.footer}
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
                            {props.renderContent ? props.renderContent({ maxHeight, maxWidth, placement, presentation, requestClose }) : <View
                                onLayout={searchable ? onResultsLayout : undefined}
                                style={{ paddingBottom: resultsPaddingBottom, minHeight: searchable ? resultsMinHeight : undefined }}
                            >
                                <SelectableMenuResults
                                    ref={resultsRef}
                                    itemSource={selectableItemSource}
                                    wrapItem={props.wrapItem}
                                    // A sheet is titled already: a category that repeats its title is not drawn twice.
                                    categories={presentation === 'sheet' ? sheetCategories : filteredCategories}
                                    selectedIndex={selectedIndex}
                                    onSelectionChange={handleResultsSelectionChange}
                                    swatchHighlightVisible={swatchHighlightVisible}
                                    onPressItem={(item) => {
                                        handlePressMenuItem(item);
                                    }}
                                    onOpenSubmenu={handleOpenSubmenu}
                                    onHoverItem={presentation === 'sheet' ? IGNORE_SHEET_HOVER : handleHoverItem}
                                    rowVariant={rowVariant}
                                    emptyLabel={emptyLabel}
                                    showCategoryTitles={props.showCategoryTitles ?? false}
                                    separateCategories={props.separateCategories}
                                    categoryDecorations={props.categoryDecorations}
                                    rowKind={props.rowKind}
                                    itemProps={props.itemRowProps}
                                    registerItemLayout={resultScroll.registerItemLayout}
                                    viewport={resultScroll.viewport}
                                    initialViewportHeight={maxHeight}
                                    onKeyDown={handleKeyDown}
                                    submenuAnchorRegistry={submenuAnchorsRef.current}
                                />
                            </View>}
                        </FloatingOverlay>
                        </View>
                        {activeSubmenu && activeSubmenuItem?.submenu ? (
                            <DropdownMenu
                                open={true}
                                onOpenChange={(next) => {
                                    if (!next) setActiveSubmenu(null);
                                }}
                                items={activeSubmenuItem.submenu.items}
                                onSelect={handleSubmenuSelect}
                                trigger={null}
                                placement={activeSubmenuItem.submenu.placement ?? 'auto-horizontal'}
                                gap={SUBMENU_POPOVER_GAP_PX}
                                maxHeightCap={activeSubmenuItem.submenu.maxHeightCap ?? props.maxHeightCap}
                                maxWidthCap={activeSubmenuItem.submenu.maxWidthCap ?? props.maxWidthCap}
                                matchTriggerWidth={false}
                                popoverAnchorRef={activeSubmenu.anchorRef}
                                popoverBoundaryRef={null}
                                search={activeSubmenuItem.submenu.search}
                                searchPlaceholder={activeSubmenuItem.submenu.searchPlaceholder}
                                emptyLabel={activeSubmenuItem.submenu.emptyLabel}
                                variant={props.variant}
                                rowKind={props.rowKind}
                                itemRowProps={props.itemRowProps}
                                showCategoryTitles={activeSubmenuItem.submenu.showCategoryTitles ?? props.showCategoryTitles}
                                separateCategories={activeSubmenuItem.submenu.separateCategories ?? props.separateCategories}
                                allowEmptySelection={props.allowEmptySelection}
                                // A menu that is a sheet on a phone opens its submenus as sheets too.
                                popoverPhonePresentation={props.popoverPhonePresentation}
                                popoverAccessibilityLabel={activeSubmenuItem.submenu.title ?? activeSubmenuItem.title}
                                onKeyboardBack={() => setActiveSubmenu(null)}
                                onSurfacePointerChange={handleSubmenuSurfacePointerChange}
                            />
                        ) : null}
                    </>;
                    }}
                </Popover>
            ) : null}
        </View>
    );
}
