import { themeSurfaceDataSet } from '@happier-dev/plugin-ui';
import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { SelectableRow, type SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';
import type { SelectableMenuCategory, SelectableMenuCategoryDecorations, SelectableMenuItem, SelectableMenuItemSource } from './selectableMenuTypes';
import { Text } from '@/components/ui/text/Text';
import type { ScrollItemLayoutHandler, ScrollViewportSource } from '@/components/ui/scroll/useScrollRectIntoView';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { focusFirstEntryWithin } from '@/keyboard/webOverlayFocusContainment';
import { HAPPIER_MENU_ROW_TEXT, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

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
    onPointerEnter: ((event: unknown) => void) | undefined;
    onLayout: ScrollItemLayoutHandler | undefined;
    /** Web: focus entered this row (focus events bubble in React). */
    onFocus?: (() => void) | undefined;
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
                onFocus: props.onFocus,
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
/** A swatch is one cell of a row, not a full-width line. */
const SWATCH_FRAME_STYLE = { display: 'flex' } as const;
// Targets abut (no gap) so 44pt hit areas never overlap; the visible geometry is concentric:
// highlight 34 → ring 26 (2px stroke, 2px gap) → fill 18.
const SWATCH_HIT_SIZE = 44;
const SWATCH_HIGHLIGHT_SIZE = 34;
const SWATCH_RING_SIZE = 26;
const SWATCH_FILL_SIZE = 18;

type RenderedMenuEntry = Readonly<{ swatchGroup: string | null; node: React.ReactElement }>;

/** Consecutive swatches of one group wrap together in a single row; every other entry stays a row. */
function groupSwatchRuns(entries: readonly RenderedMenuEntry[], rowStyle: object): React.ReactNode[] {
    const output: React.ReactNode[] = [];
    let run: React.ReactElement[] = [];
    let runGroup: string | null = null;
    const flush = () => {
        if (run.length === 0) return;
        output.push(<View key={`swatch-row:${String(run[0]!.key)}`} style={rowStyle}>{run}</View>);
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
const SUBMENU_ANCHOR_FRAME_STYLE = { ...ROW_FRAME_STYLE, position: 'relative' } as const;

type CheckRole = 'radio' | 'checkbox';

/**
 * A row's height before it has been on screen, from what it shows: the menu row's minimum, or a label line, the
 * subtitle gap and a subtitle line inside the row's padding. Close estimates keep a row that has not been measured
 * where it will be, so revealing a far row (the current choice, End) lands on it.
 */
const MENU_ROW_ESTIMATE_PX = MENU_ROW_METRICS.minHeightPx;
const MENU_ROW_WITH_SUBTITLE_ESTIMATE_PX = Math.max(
    MENU_ROW_METRICS.minHeightPx,
    MENU_ROW_METRICS.paddingVerticalPx * 2 + HAPPIER_MENU_ROW_TEXT.label.lineHeight
        + MENU_ROW_METRICS.subtitleGapPx + HAPPIER_MENU_ROW_TEXT.subtitle.lineHeight,
);

/**
 * The results' structure, built once per change of results (a new inventory, a filter), never per measurement:
 * group bounds, choice roles, each row's estimated top, and the measured rows' differences from their estimates
 * held in a Fenwick (binary indexed) sum, so one new measurement costs O(log n) and never walks the inventory.
 */
type MenuRowStructure = Readonly<{
    rowCount: number;
    /** First flat row of each category, then the row count. */
    categoryStarts: readonly number[];
    checkRoles: readonly CheckRole[];
    /** Per category: whether its rows reserve the leading icon column. */
    leadingSlots: readonly boolean[];
    /** Swatch palettes wrap into shared rows, so they are always drawn whole. */
    hasSwatch: boolean;
    /** Estimated top of each flat row from the first, then the estimated end. */
    estimatedTops: Float64Array;
    /** Measured height by flat row; 0 until the row has been on screen. */
    measured: Float64Array;
    /** Measured minus estimated height, by flat row. */
    measuredDeltas: Float64Array;
}>;

function fenwickAdd(tree: Float64Array, index: number, delta: number): void {
    for (let at = index + 1; at < tree.length; at += at & -at) tree[at] = tree[at]! + delta;
}

/** The sum over rows [0, end). */
function fenwickPrefix(tree: Float64Array, end: number): number {
    let total = 0;
    for (let at = end; at > 0; at -= at & -at) total += tree[at]!;
    return total;
}

/**
 * Where each row sits for one render: its estimated top moved by the measured rows above it, and its measured height
 * once it has been on screen. `chromeBefore[k]`: the group chrome (separators, titles, notes) above category k's rows.
 */
type MenuRowGeometry = Readonly<{
    rowCount: number;
    top: (index: number) => number;
    height: (index: number) => number;
}>;

function createRowGeometry(structure: MenuRowStructure, chromeBefore: readonly number[]): MenuRowGeometry {
    const { rowCount, categoryStarts, estimatedTops, measured, measuredDeltas } = structure;
    // The category holding a row: the last whose first row is at or before it (an empty category yields to the next).
    const categoryOf = (index: number) => {
        let low = 0;
        let high = categoryStarts.length - 2;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (categoryStarts[mid]! <= index) low = mid;
            else high = mid - 1;
        }
        return low;
    };
    return {
        rowCount,
        top: (index) => MENU_ROW_METRICS.sectionPaddingVerticalPx + (chromeBefore[categoryOf(index)] ?? 0)
            + estimatedTops[index]! + fenwickPrefix(measuredDeltas, index),
        height: (index) => measured[index] || estimatedTops[index + 1]! - estimatedTops[index]!,
    };
}

/** The first row whose bottom lies below `y`. */
function firstRowEndingAfter(geometry: MenuRowGeometry, y: number): number {
    let low = 0;
    let high = geometry.rowCount - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (geometry.top(mid) + geometry.height(mid) > y) high = mid;
        else low = mid + 1;
    }
    return low;
}

/** The last row whose top lies above `y`. */
function lastRowStartingBefore(geometry: MenuRowGeometry, y: number): number {
    let low = 0;
    let high = geometry.rowCount - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (geometry.top(mid) < y) low = mid;
        else high = mid - 1;
    }
    return low;
}

type MountedRowRange = Readonly<{ start: number; end: number }>;

/** The rows between two mounted ones, kept as their height so the scroller's extent and position stay true. */
function unmountedRows(fromIndex: number, height: number): RenderedMenuEntry {
    return {
        swatchGroup: null,
        node: (
            <View
                key={`unmounted:${fromIndex}`}
                testID="selectable-menu-unmounted-rows"
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{ height }}
            />
        ),
    };
}

const stylesheet = StyleSheet.create((theme) => ({
    swatchRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: theme.space.s4,
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
        alignItems: 'center',
        justifyContent: 'center',
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
        // Ink hairline keeps pale colours (yellow, near-white customs) from dissolving into the menu.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    container: {
        paddingVertical: MENU_ROW_METRICS.sectionPaddingVerticalPx,
    },
    leadingSlot: {
        width: MENU_ROW_METRICS.iconGlyphSizePx,
        height: MENU_ROW_METRICS.iconGlyphSizePx,
    },
    trailingWithCheck: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
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
        // The rows' own inset (`SelectableRow` menu rows), so the label starts where its rows start.
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
        color: theme.colors.text.secondary,
    },
    categoryHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s4,
    },
    categoryHeaderTitle: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    categoryNote: {
        ...Typography.variant('meta', 'regular'),
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s8,
        color: theme.colors.text.tertiary,
    },
    categorySeparator: {
        height: StyleSheet.hairlineWidth,
        // Edge to edge like the rows it parts: popovers are full-bleed (MENU_ROW_METRICS).
        marginHorizontal: 0,
        marginVertical: MENU_ROW_METRICS.sectionPaddingVerticalPx,
        backgroundColor: theme.colors.border.subtle,
    },
    itemRowPressable: {
        alignSelf: 'stretch',
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
    /** The pointer rests on a row (mouse/pen); the menu decides whether its submenu opens or closes. */
    onHoverItem?: (item: SelectableMenuItem, anchorRef: React.RefObject<unknown>) => void;
    rowVariant: SelectableRowVariant;
    emptyLabel?: React.ReactNode;
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
    /**
     * Whether the highlighted row or swatch draws its highlight (default true). A menu opened by a pointer draws
     * none until the person hovers or uses the keyboard: a resting highlight on the first row reads as a choice.
     */
    highlightVisible?: boolean;
    /** Owner-supplied map so the menu can open a submenu from the keyboard at the anchor a pointer uses. */
    submenuAnchorRegistry?: Map<string, React.RefObject<unknown>>;
    /**
     * The scroller holding these results. With it, a long menu mounts only the rows in and around view (one
     * viewport above and below, plus the highlighted row); every choice stays reachable by scrolling, typing and
     * the keyboard. Without it, every row is mounted.
     */
    viewport?: ScrollViewportSource;
    /**
     * Presentation on demand: the categories hold each choice's identity and matching text, and a row's full item
     * (trailing counts, marks) is asked of the source only once that row is mounted.
     */
    itemSource?: SelectableMenuItemSource;
    /** The scroller's height before it has laid out (the overlay's maximum height). */
    initialViewportHeight?: number;
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
    const paintColor = useHappierMaterialColorResolver();
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const separatorSurfaceStyle = themeSurfaceStyles.surface(surfaceOverridesEnabled ? { surface: 'menu', part: 'separator' } : undefined);
    // A choice row (radio) shows which one is current; the mark yields to a row's own trailing content.
    const checkMark = <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.primary} />;
    const rowAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());
    const submenuAnchorRefs = React.useRef(new Map<string, React.RefObject<View | null>>());

    const allItems = React.useMemo(() => props.categories.flatMap((c) => c.items), [props.categories]);
    // A row the keyboard moves focus to may not be mounted yet (End in a long menu): focus it once it is.
    const pendingFocusIdRef = React.useRef<string | null>(null);
    React.useImperativeHandle(ref, () => ({
        focusItem(index) {
            if (Platform.OS !== 'web') return;
            const item = allItems[index];
            if (!item || item.disabled) return;
            const node = rowAnchorRefs.current.get(String(item.id))?.current as unknown as HTMLElement | null;
            pendingFocusIdRef.current = node ? null : String(item.id);
            if (node) focusFirstEntryWithin(node);
        },
    }), [allItems]);
    useBrowserLayoutEffect(() => {
        const pendingId = pendingFocusIdRef.current;
        if (pendingId === null) return;
        const node = rowAnchorRefs.current.get(pendingId)?.current as unknown as HTMLElement | null;
        if (!node) return;
        pendingFocusIdRef.current = null;
        focusFirstEntryWithin(node);
    });

    // Measured heights: rows by id (kept across filtering), group chrome by key. A new measurement re-places the rows
    // that are not mounted through the structure's Fenwick sums, in O(log n).
    const rowHeightsRef = React.useRef(new Map<string, number>());
    const chromeHeightsRef = React.useRef(new Map<string, number>());
    const [, setMeasureRevision] = React.useState(0);
    const showCategoryTitles = props.showCategoryTitles !== false;
    const rowStructure = React.useMemo((): MenuRowStructure => {
        const rowCount = allItems.length;
        const estimatedTops = new Float64Array(rowCount + 1);
        const measured = new Float64Array(rowCount);
        const measuredDeltas = new Float64Array(rowCount + 1);
        const categoryStarts: number[] = [];
        const checkRoles: CheckRole[] = [];
        // The leading column is reserved per section (owner 2026-11-10): a section where only some rows carry an icon
        // keeps one text edge, its others holding the same empty slot; a section with none starts at the text edge.
        const leadingSlots: boolean[] = [];
        const knownHeights = rowHeightsRef.current;
        let hasSwatch = false;
        let index = 0;
        for (const category of props.categories) {
            categoryStarts.push(index);
            let checkedCount = 0;
            let multiSelect = false;
            let leadingSlot = false;
            for (const item of category.items) {
                if (item.left != null || item.multiSelect === true) leadingSlot = true;
                if (item.checked !== undefined) checkedCount++;
                if (item.multiSelect === true) multiSelect = true;
                if (item.swatch) hasSwatch = true;
                const estimate = item.subtitle || item.subtitleNode ? MENU_ROW_WITH_SUBTITLE_ESTIMATE_PX : MENU_ROW_ESTIMATE_PX;
                estimatedTops[index + 1] = estimatedTops[index]! + estimate;
                const known = knownHeights.size > 0 ? knownHeights.get(String(item.id)) : undefined;
                if (known !== undefined) {
                    measured[index] = known;
                    fenwickAdd(measuredDeltas, index, known - estimate);
                }
                index++;
            }
            // Checked rows among siblings are one choice (radios) unless they say they are independent
            // (multi-select); a lone checked row is an on/off toggle.
            checkRoles.push(checkedCount > 1 && !multiSelect ? 'radio' : 'checkbox');
            leadingSlots.push(leadingSlot);
        }
        categoryStarts.push(index);
        return { rowCount, categoryStarts, checkRoles, leadingSlots, hasSwatch, estimatedTops, measured, measuredDeltas };
    }, [allItems.length, props.categories]);
    const recordRowHeight = React.useCallback((structure: MenuRowStructure, index: number, itemId: string, height: unknown) => {
        if (typeof height !== 'number' || !(height > 0)) return;
        const previous = structure.measured[index] || structure.estimatedTops[index + 1]! - structure.estimatedTops[index]!;
        if (structure.measured[index] === height) return;
        rowHeightsRef.current.set(itemId, height);
        structure.measured[index] = height;
        fenwickAdd(structure.measuredDeltas, index, height - previous);
        setMeasureRevision((value) => value + 1);
    }, []);
    const recordChromeHeight = React.useCallback((key: string, height: number) => {
        if (!(height > 0) || chromeHeightsRef.current.get(key) === height) return;
        chromeHeightsRef.current.set(key, height);
        setMeasureRevision((value) => value + 1);
    }, []);
    // Group chrome above each category's rows: one step per category, not per row.
    const chromeBefore: number[] = [];
    {
        const chrome = (key: string) => chromeHeightsRef.current.get(key) ?? 0;
        let chromeY = 0;
        let renderedGroups = 0;
        for (const category of props.categories) {
            if (category.items.length > 0) {
                if (props.separateCategories === true && renderedGroups > 0) chromeY += chrome(`${category.id}:separator`);
                if (showCategoryTitles && category.title.trim().length > 0) chromeY += chrome(`${category.id}:title`);
            }
            chromeBefore.push(chromeY);
            if (category.items.length > 0) {
                renderedGroups++;
                if (props.categoryDecorations?.[category.title]?.note) chromeY += chrome(`${category.id}:note`);
            }
        }
    }
    const rowGeometry = createRowGeometry(rowStructure, chromeBefore);

    // Which rows are mounted: those within a viewport of the visible window, plus the highlighted one.
    const viewport = rowStructure.hasSwatch ? undefined : props.viewport;
    const initialViewportHeight = props.initialViewportHeight ?? 0;
    const [, setViewportTick] = React.useState(0);
    let mountedRange: MountedRowRange | null = null;
    if (viewport && allItems.length > 0) {
        const metrics = viewport.get();
        const viewportHeight = metrics.viewportHeight > 0 ? metrics.viewportHeight : initialViewportHeight;
        if (viewportHeight > 0) {
            const start = firstRowEndingAfter(rowGeometry, metrics.offsetY - viewportHeight);
            const end = lastRowStartingBefore(rowGeometry, metrics.offsetY + viewportHeight * 2);
            if (start > 0 || end < allItems.length - 1) mountedRange = { start, end };
        }
    }
    const mountedRangeRef = React.useRef<MountedRowRange | null>(mountedRange);
    mountedRangeRef.current = mountedRange;
    const rowGeometryRef = React.useRef(rowGeometry);
    rowGeometryRef.current = rowGeometry;
    React.useEffect(() => {
        if (!viewport) return undefined;
        return viewport.subscribe(() => {
            const mounted = mountedRangeRef.current;
            const layout = rowGeometryRef.current;
            if (layout.rowCount === 0) return;
            const metrics = viewport.get();
            const viewportHeight = metrics.viewportHeight > 0 ? metrics.viewportHeight : initialViewportHeight;
            const visibleStart = firstRowEndingAfter(layout, metrics.offsetY);
            const visibleEnd = lastRowStartingBefore(layout, metrics.offsetY + viewportHeight);
            // Re-render only once the visible rows leave the mounted ones, not on every scroll event.
            if (mounted === null || (visibleStart >= mounted.start && visibleEnd <= mounted.end)) return;
            setViewportTick((value) => value + 1);
        });
    }, [initialViewportHeight, viewport]);
    // Rows are measured only while some are left unmounted: a menu drawn whole lays out as it always has.
    const measuring = mountedRange !== null;
    // The row holding keyboard focus stays mounted too, or scrolling it away would drop focus to the page and
    // leave the keys with nothing to act on.
    const [focusedRow, setFocusedRow] = React.useState<Readonly<{ structure: MenuRowStructure; index: number }> | null>(null);
    const focusedIndex = focusedRow !== null && focusedRow.structure === rowStructure ? focusedRow.index : -1;
    const registerItemLayout = props.registerItemLayout;
    const rowLayoutHandlers = React.useMemo(() => new Map<string, ScrollItemLayoutHandler | undefined>(), [measuring, recordRowHeight, registerItemLayout, rowStructure]);
    const getRowLayoutHandler = (itemId: string, itemIndex: number): ScrollItemLayoutHandler | undefined => {
        if (rowLayoutHandlers.has(itemId)) return rowLayoutHandlers.get(itemId);
        const registered = registerItemLayout?.(itemId);
        const handler: ScrollItemLayoutHandler | undefined = measuring
            ? (event) => {
                registered?.(event);
                recordRowHeight(rowStructure, itemIndex, itemId, event.nativeEvent?.layout?.height);
            }
            : registered;
        rowLayoutHandlers.set(itemId, handler);
        return handler;
    };
    // `outside`: the chrome's own vertical margins, which its layout does not include.
    const chromeLayout = (key: string, outside = 0) => measuring
        ? (event: LayoutChangeEvent) => recordChromeHeight(key, event.nativeEvent.layout.height + outside)
        : undefined;
    const getRowAnchorRef = React.useCallback((itemId: string): React.RefObject<View | null> => {
        const existing = rowAnchorRefs.current.get(itemId);
        if (existing) return existing;
        const created = React.createRef<View>();
        rowAnchorRefs.current.set(itemId, created);
        return created;
    }, []);
    const submenuAnchorRegistry = props.submenuAnchorRegistry;
    const getSubmenuAnchorRef = React.useCallback((itemId: string): React.RefObject<View | null> => {
        const existing = submenuAnchorRefs.current.get(itemId);
        if (existing) return existing;
        const created = React.createRef<View>();
        submenuAnchorRefs.current.set(itemId, created);
        submenuAnchorRegistry?.set(itemId, created as React.RefObject<unknown>);
        return created;
    }, [submenuAnchorRegistry]);
    const handleOpenSubmenu = React.useCallback((item: SelectableMenuItem, anchorRef: React.RefObject<unknown>) => {
        if (!item.hasSubmenu || item.disabled) return false;
        props.onOpenSubmenu?.(item.id, anchorRef);
        return true;
    }, [props]);
    const handlePressItem = React.useCallback((item: SelectableMenuItem) => {
        props.onPressItem(item);
    }, [props.onPressItem]);
    const isPrimaryWebActivationEvent = React.useCallback((event: WebMouseDownActivationEvent) => {
        const button = event.nativeEvent?.button ?? event.button;
        return typeof button !== 'number' || button === 0;
    }, []);

    if (props.categories.length === 0 || allItems.length === 0) {
        if (!props.emptyLabel) return null;
        // A composed empty state owns its own padding and type; a sentence takes the menu's.
        if (typeof props.emptyLabel !== 'string') return <>{props.emptyLabel}</>;
        return (
            <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>
                    {props.emptyLabel}
                </Text>
            </View>
        );
    }

    let renderedCategories = 0;
    const rowKind = props.rowKind ?? 'selectableRow';

    const content = (
        <View style={styles.container}>
            {props.categories.map((category, categoryIndex) => {
                if (category.items.length === 0) return null;

                const categoryStartIndex = rowStructure.categoryStarts[categoryIndex]!;
                const checkRole = rowStructure.checkRoles[categoryIndex]!;
                const reservesLeadingSlot = rowStructure.leadingSlots[categoryIndex] === true;
                const renderEntry = (listedItem: SelectableMenuItem, itemIndex: number): RenderedMenuEntry => {
                    const sourceIndex = props.itemSource?.indexById.get(String(listedItem.id));
                    const item = (sourceIndex === undefined ? undefined : props.itemSource?.getItem(sourceIndex)) ?? listedItem;
                    const isSelected = itemIndex === props.selectedIndex && props.highlightVisible !== false;
                    const checked = item.checked === true && item.multiSelect !== true ? checkMark : null;
                    // A row's trailing fact (a designation) and its check sit together; the check never displaces it.
                    const right = item.right != null && checked !== null
                        ? <View style={styles.trailingWithCheck}>{item.right}{checked}</View>
                        : item.right ?? checked;
                    const left = item.left
                        ?? (item.multiSelect === true ? <MenuCheckBox checked={item.checked === true} rowKind={rowKind} /> : null)
                        ?? (reservesLeadingSlot ? <View style={styles.leadingSlot} /> : null);
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
                                // Opening a sheet submenu can cover this row before the compatibility
                                // release/click. Shield that same activation just as a leaf selection does.
                                installWebTrailingClickBlocker();
                                if (handleOpenSubmenu(item, submenuAnchorRef as React.RefObject<unknown>)) return;
                                handlePressItem(item);
                            })
                            : undefined;
                    // Hover reports every row; the menu owns the intent (dwell, sibling close, grace).
                    const handleOpenItemSubmenu = () => {
                        if (props.onHoverItem) {
                            props.onHoverItem(item, submenuAnchorRef as React.RefObject<unknown>);
                            return;
                        }
                        handleOpenSubmenu(item, submenuAnchorRef as React.RefObject<unknown>);
                    };
                    if (item.swatch) {
                        const swatch = item.swatch;
                        return {
                            swatchGroup: swatch.group ?? '',
                            node: (
                                <SelectableMenuRowFrame
                                    key={item.id}
                                    testID={`${optionTestID}:scroll-frame`}
                                    rowAnchorRef={rowAnchorRef}
                                    style={SWATCH_FRAME_STYLE}
                                    onMouseDownCapture={handleOptionMouseDownCapture}
                                    onKeyDown={Platform.OS === 'web' ? props.onKeyDown : undefined}
                                    onPointerEnter={undefined}
                                    onLayout={getRowLayoutHandler(String(item.id), itemIndex)}
                                >
                                    <Pressable
                                        testID={optionTestID}
                                        accessibilityRole="radio"
                                        accessibilityLabel={item.accessibilityLabel ?? item.title}
                                        accessibilityHint={item.subtitle}
                                        accessibilityState={{ checked: item.checked === true, disabled: item.disabled === true }}
                                        disabled={item.disabled}
                                        onPress={() => {
                                            if (item.disabled) return;
                                            handlePressItem(item);
                                        }}
                                        onHoverIn={() => {
                                            if (item.disabled) return;
                                            props.onSelectionChange(itemIndex);
                                            handleOpenItemSubmenu();
                                        }}
                                        style={({ pressed }) => [styles.swatchHit, pressed ? styles.swatchHitPressed : null]}
                                    >
                                            <View
                                                testID={isSelected ? `${optionTestID}:highlight` : undefined}
                                                style={[
                                                    styles.swatchHighlight,
                                                    // The menu row's own highlight: an ink fill, never an outline.
                                                    isSelected ? { backgroundColor: paintColor(theme.colors.surface.selected) } : null,
                                                ]}
                                            >
                                                <View
                                                    style={[
                                                        styles.swatchRing,
                                                        item.checked === true
                                                            ? styles.swatchRingChecked
                                                            : swatch.inherited ? styles.swatchRingInherited : null,
                                                    ]}
                                                >
                                                    {swatch.empty ? (
                                                        <View style={[styles.swatchFill, styles.swatchFillEmpty]}>
                                                            <View testID={`${optionTestID}:strike`} style={styles.swatchStrike} />
                                                        </View>
                                                    ) : (
                                                        <View style={[styles.swatchFill, { backgroundColor: swatch.color }]} />
                                                    )}
                                                </View>
                                            </View>
                                    </Pressable>
                                </SelectableMenuRowFrame>
                            ),
                        };
                    }
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

                    const scrollFrameLayout = getRowLayoutHandler(String(item.id), itemIndex);
                    const rowFrameTestID = `${optionTestID}:scroll-frame`;
                    const rowFramePointerEnter = Platform.OS === 'web' ? (event: unknown) => {
                        // Touch has no hover: a tap opens the submenu through the press path.
                        const pointerType = (event as { nativeEvent?: { pointerType?: unknown }; pointerType?: unknown } | null);
                        if ((pointerType?.nativeEvent?.pointerType ?? pointerType?.pointerType) === 'touch' || item.disabled) return;
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
                    return { swatchGroup: null, node: (
                        <SelectableMenuRowFrame
                            key={item.id}
                            testID={rowFrameTestID}
                            rowAnchorRef={rowAnchorRef}
                            style={item.hasSubmenu ? SUBMENU_ANCHOR_FRAME_STYLE : ROW_FRAME_STYLE}
                            onMouseDownCapture={handleOptionMouseDownCapture}
                            onKeyDown={Platform.OS === 'web' ? props.onKeyDown : undefined}
                            onPointerEnter={rowFramePointerEnter}
                            onLayout={scrollFrameLayout}
                            onFocus={measuring && focusedIndex !== itemIndex
                                ? () => setFocusedRow({ structure: rowStructure, index: itemIndex })
                                : undefined}
                        >
                            {props.wrapItem ? props.wrapItem(item, rowFrameChildren) : rowFrameChildren}
                        </SelectableMenuRowFrame>
                    ) };
                };

                const categoryEnd = categoryStartIndex + category.items.length;
                const categoryItems: RenderedMenuEntry[] = [];
                if (mountedRange === null) {
                    category.items.forEach((item, idx) => categoryItems.push(renderEntry(item, categoryStartIndex + idx)));
                } else {
                    const from = Math.max(categoryStartIndex, mountedRange.start);
                    const to = Math.min(categoryEnd - 1, mountedRange.end);
                    const mounted: number[] = [];
                    for (let index = from; index <= to; index++) mounted.push(index);
                    // The highlighted and the focused rows stay mounted wherever they are, so the keyboard can
                    // reach and reveal them.
                    for (const pinned of [props.selectedIndex, focusedIndex]) {
                        if (pinned < categoryStartIndex || pinned >= categoryEnd || (pinned >= from && pinned <= to)) continue;
                        if (!mounted.includes(pinned)) mounted.push(pinned);
                    }
                    mounted.sort((a, b) => a - b);
                    let cursor = categoryStartIndex;
                    for (const index of mounted) {
                        if (index > cursor) categoryItems.push(unmountedRows(cursor, rowGeometry.top(index) - rowGeometry.top(cursor)));
                        categoryItems.push(renderEntry(category.items[index - categoryStartIndex]!, index));
                        cursor = index + 1;
                    }
                    if (cursor < categoryEnd) {
                        const categoryBottom = rowGeometry.top(categoryEnd - 1) + rowGeometry.height(categoryEnd - 1);
                        categoryItems.push(unmountedRows(cursor, categoryBottom - rowGeometry.top(cursor)));
                    }
                }

                const decoration = props.categoryDecorations?.[category.title];
                const separated = props.separateCategories === true && renderedCategories > 0;
                renderedCategories++;
                return (
                    <View key={category.id}>
                        {separated ? <View {...{ dataSet: themeSurfaceDataSet('menu', 'separator', 'default') }} style={[styles.categorySeparator, separatorSurfaceStyle]} onLayout={chromeLayout(`${category.id}:separator`, MENU_ROW_METRICS.sectionPaddingVerticalPx * 2)} /> : null}
                        {showCategoryTitles && category.title.trim().length > 0 ? (
                            decoration?.icon ? (
                                <View style={styles.categoryHeader} accessibilityRole="header" onLayout={chromeLayout(`${category.id}:title`)}>
                                    {decoration.icon}
                                    <Text style={styles.categoryHeaderTitle}>{category.title}</Text>
                                </View>
                            ) : (
                                <Text style={styles.categoryTitle} accessibilityRole="header" onLayout={chromeLayout(`${category.id}:title`)}>
                                    {category.title}
                                </Text>
                            )
                        ) : null}
                        {groupSwatchRuns(categoryItems, styles.swatchRow)}
                        {decoration?.note ? <Text style={styles.categoryNote} onLayout={chromeLayout(`${category.id}:note`)}>{decoration.note}</Text> : null}
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
