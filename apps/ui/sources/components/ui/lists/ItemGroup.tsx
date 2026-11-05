import * as React from 'react';
import {
    View,
    StyleProp,
    ViewStyle,
    TextStyle,
    Platform,
    type LayoutChangeEvent,
} from 'react-native';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    flattenItemGroupElementChildren,
    withItemGroupDividers,
    withItemGroupSheetRows,
    type ItemGroupVirtualizedSegment,
} from './ItemGroup.dividers';
import { ItemGroupRowPositionProvider } from './ItemGroupRowPosition';
import { countSelectableItems } from './ItemGroup.selectableCount';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { resolveThemeCardChromeStyle, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { GlassSurface, renderThemeMaterialSurface } from '@/components/ui/glass/GlassSurface';
import { projectPluginUiHostPalette } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { ItemGroupColumns } from './ItemGroupColumns';
import {
    ITEM_GROUP_COLUMN_GAP_PX,
    ITEM_GROUP_COLUMN_ROW_GAP_PX,
    resolveItemGroupColumnCountForWidth,
} from './itemGroupColumnLayout';
import {
    ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX,
    ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX,
    ITEM_GROUP_HEADER_HORIZONTAL_PADDING_PX,
    ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX,
} from './itemGroupSpacing';
import { Text } from '@/components/ui/text/Text';
import { MenuSectionRowsContext, useFloatingListSurface, useListPresentation, usePageListInsets } from './listPresentation';
import { MENU_ROW_METRICS } from './itemDensityMetrics';
import { SelectionListSectionHeader } from '@/components/ui/selectionList/SelectionListSectionHeader';
import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from './pageListMetrics';
import { SectionItemDensityProvider, usePageRowDensityOverride, useResolvedItemDensity, type ResolvedItemDensity } from './useResolvedItemDensity';
import { ITEM_ROW_PADDING_HORIZONTAL } from './itemDensityMetrics';
import { SectionLeadingColumnProvider } from './sectionLeadingColumn';
import { BareRowBleedContext } from './bareRowBleed';
import {
    HappierItemGroupBehavior,
    HappierItemGroupSelectionContext,
    HappierPageSectionHeader,
    HappierPageSheet,
    type HappierPageSectionHeaderProps,
    type HappierPageSheetProps,
    happierPageTextMetrics,
    resolveHappierItemGroupConstraints,
} from '@happier-dev/plugin-ui/presentation';


export { withItemGroupDividers } from './ItemGroup.dividers';

export { HappierItemGroupSelectionContext as ItemGroupSelectionContext } from '@happier-dev/plugin-ui/presentation';

export interface ItemGroupProps {
    /** Identifies the whole section (header and rows) for tests and automation. */
    testID?: string;
    /** A containing sheet may already own this section's header and spacing. */
    header?: 'section' | 'none';
    title?: string | React.ReactNode;
    /**
     * What this section is about, read before its rows. Page presentation renders it under the
     * section title; grouped presentation (menus, pickers, sheets) renders it as the footer. Rich
     * content (a localized sentence around an `InlineCode`) is set in the same description text.
     */
    description?: React.ReactNode;
    /** A compact section-level action (e.g. "Check now", "Add"), aligned with the section title. */
    action?: React.ReactNode;
    /** The shared header's fit-aware inline default, or its narrow-page adaptive layout. */
    actionLayout?: HappierPageSectionHeaderProps['actionLayout'];
    /**
     * A short live fact read with the title and set beside it ("Machines ● 2 online · ● 1 offline").
     * Page sections only; it never replaces the description.
     */
    titleAccessory?: React.ReactNode;
    /**
     * An identity mark set before a page section title (a lead Session's agent mark, a run's glyph),
     * for sections that are about one thing. Page sections only.
     */
    titleLeading?: React.ReactNode;
    children: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    /** The group's accessible name; a string title is the default. */
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    constrainToContentWidth?: boolean;
    /** Clips edge-to-edge child surfaces to the rounded inner card boundary. */
    clipContent?: boolean;
    /** Joins independently virtualized chunks into one logical group surface. */
    virtualizedSegment?: ItemGroupVirtualizedSegment;
    /**
     * Lay the rows out as a grid of standalone cards instead of one shared card,
     * up to this many columns. Collapses back to the single shared card whenever
     * the available width cannot give every column a usable minimum width, so
     * phones and narrow panes are unaffected.
     *
     * Mutually exclusive with `virtualizedSegment` (which models one CONTINUOUS
     * surface) and with `accessibilityRole="radiogroup"` (whose arrow-key roving
     * follows child order, which stops matching what the eye sees once rows are
     * dealt across columns). Both combinations throw rather than render wrong.
     */
    columns?: 1 | 2 | 3 | 4;
    /**
     * `sheet` (default) draws the shared card. `none` lays the children out on the page with the same
     * insets and no card, for a section whose content is its own surface (action tiles, a button row).
     */
    surface?: 'sheet' | 'none';
    /**
     * The density of every row in this section. Row height follows content: a long index-style list of
     * single-line rows (shortcuts, languages) is `compact`; leave it unset for rows that carry a
     * description or a control beneath. On a configuration page `compact` asks for the list shape of
     * the user's list-density preference (`resolvePageRowMetrics`), so the preference still reaches it;
     * elsewhere it replaces the preference.
     */
    density?: ResolvedItemDensity;
    /**
     * Performance: when you already know how many selectable rows are inside the group,
     * pass this to avoid walking the full React children tree on every render.
     */
    selectableItemCountOverride?: number;
}

const stylesheet = StyleSheet.create((theme) => {
    // The one in-flow card (W3 on light): its hairline, lip and grounding.
    const surfaceChromeStyle = resolveThemeCardChromeStyle(theme);

    // ONE card-chrome definition, shared by the single shared card and by each
    // standalone card in the multi-column layout, so the two can never drift.
    const cardChrome = {
        // A card: one step of the dark surface ladder above the page (the page under a breath of ink on light).
        backgroundColor: theme.colors.edge.cardFill,
        borderRadius: GROUPED_SURFACE_RADIUS_PX,
        ...surfaceChromeStyle,
        // IMPORTANT: allow popovers to overflow this rounded container.
        overflow: 'visible' as const,
    };

    return {
        wrapper: {
            alignItems: 'center',
        },
        container: {
            width: '100%',
            paddingHorizontal: Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX),
        },
        containedContainer: {
            paddingHorizontal: 0,
        },
        containedContent: {
            marginHorizontal: 0,
        },
        header: {
            paddingTop: Platform.select({ ios: 26, default: 20 }),
            paddingBottom: Platform.select({ ios: 8, default: 8 }),
            paddingHorizontal: Platform.select(ITEM_GROUP_HEADER_HORIZONTAL_PADDING_PX),
        },
        headerNoTitle: {
            paddingTop: Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX),
        },
        // On a page every block — a titled section, an untitled sheet, a banner, a button row — starts
        // one section gap below what precedes it (the page header included), so the header → first
        // block distance is the same whatever the first block is.
        pageHeaderNoTitle: {
            paddingTop: PAGE_LIST_METRICS.sectionGapPx,
        },
        // U8.5 craft S2: grouped section titles (menus, pickers, sheets) are sentence case in the
        // secondary colour, medium weight — never an uppercase eyebrow.
        headerText: {

            color: theme.colors.text.secondary,
            ...Typography.variant('body', 'medium'),


            textTransform: 'none',
        },
        contentContainerOuter: {
            ...cardChrome,
            marginHorizontal: Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX),
        },
        contentContainerBare: {
            marginHorizontal: Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX),
        },
        contentContainerInner: {
            borderRadius: GROUPED_SURFACE_RADIUS_PX,
        },
        contentContainerInnerClipped: {
            overflow: 'hidden',
        },
        // The element the columned body measures itself by. It carries no inset
        // of its own, so its width is the group's content box in BOTH column
        // states — measuring the card instead would shrink by the content margin
        // at one column and oscillate across the breakpoint.
        columnsMeasureHost: {
            width: '100%',
        },
        // NOTE: no `marginHorizontal` here. The columns root is `width: '100%'`,
        // and margin sits OUTSIDE a resolved width — the grid would occupy
        // 100% + 2*margin and overrun the single card's box. The matching inset
        // is applied as PADDING via the `paddingHorizontal` prop instead.
        columnsBody: {
            width: '100%',
        },
        // One cell per ROW, always. The resolved column count is expressed as the
        // cell's `flexBasis` so the wrapping grid re-flows on resize instead of
        // the rows being re-parented into a different container.
        columnCell: {
            minWidth: 0,
        },
        columnCardOuter: cardChrome,
        virtualizedSurfaceSegment: {
            boxShadow: 'none',
            shadowOpacity: 0,
            elevation: 0,
        },
        virtualizedSurfaceContinuesBefore: {
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            borderTopWidth: 0,
        },
        virtualizedSurfaceContinuesAfter: {
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            borderBottomWidth: 0,
        },
        pageTitle: {
            ...Typography.default('bold'),
            ...happierPageTextMetrics('sectionTitle'),
            color: theme.colors.text.primary,
        },
        pageTitleRow: {
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            columnGap: theme.space.s10,
            rowGap: theme.space.s2,
        },
        pageTitleName: {
            flexDirection: 'row',
            alignItems: 'center',
            flexShrink: 1,
            minWidth: 0,
            columnGap: theme.space.s10,
        },
        pageTitleText: {
            flexShrink: 1,
            minWidth: 0,
        },
        pageDescription: {
            ...Typography.default('regular'),
            ...happierPageTextMetrics('sectionDescription'),
            color: theme.colors.text.secondary,
            marginTop: theme.space.s2,
        },
        // An inspector pane's section description reads at the meta step, under a body-sized row list.
        pageDescriptionInspector: {
            ...Typography.variant('meta'),
        },
        // An inspector's rows are short and carry their own air (36px rows), so its section heading sits
        // close to them and a step nearer the section above: a title reads as its rows' label, not as a
        // gap between two lists.
        pageHeaderInspector: {
            paddingTop: theme.space.s24,
            paddingBottom: theme.space.s4,
        },
        pageHeaderNoTitleInspector: {
            paddingTop: theme.space.s24,
        },
        // A page section's sheet sits on the same content margin as the grouped card; its look is the
        // shared page sheet's (`HappierPageSheet`).
        pageSheetFlat: {
            marginLeft: (Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 12)
                + PAGE_LIST_METRICS.headingOpticalInsetPx - PAGE_LIST_METRICS.rowPaddingHorizontalPx,
            // The hairlines end on the content's trailing edge, where the section's controls end.
            marginRight: (Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 12)
                + PAGE_LIST_METRICS.headingOpticalInsetPx,
        },
        pageSheet: {
            marginHorizontal: Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX),
            // IMPORTANT: allow popovers to overflow the sheet (as the grouped card does).
            overflow: 'visible',
        },
        footer: {
            paddingTop: Platform.select({ ios: 6, default: 8 }),
            paddingBottom: Platform.select({ ios: 8, default: 16 }),
            paddingHorizontal: Platform.select(ITEM_GROUP_HEADER_HORIZONTAL_PADDING_PX),
        },
        footerText: {
            ...Typography.variant('body'),
            color: theme.colors.text.secondary,
        },
        // A section on a floating surface is a menu section (the anatomy `ActionListSection` draws): no
        // card inside the floating card, the label and rows on the menu's text edge, the menu's rhythm.
        menuSection: {
            width: '100%',
            paddingVertical: MENU_ROW_METRICS.sectionPaddingVerticalPx,
        },
        menuSectionRows: {
            paddingHorizontal: MENU_ROW_METRICS.insetPx,
        },
        menuSectionDescription: {
            paddingHorizontal: MENU_ROW_METRICS.insetPx + MENU_ROW_METRICS.paddingHorizontalPx,
            paddingBottom: MENU_ROW_METRICS.paddingVerticalPx - MENU_ROW_METRICS.sectionPaddingVerticalPx,
        },
        menuSectionDescriptionText: {
            ...Typography.variant('meta'),
            color: theme.colors.text.secondary,
        },
    };
});

/**
 * The default layout: every row inside one shared card, separated by dividers.
 * Owns the group-level accessibility container and the virtualized-chunk
 * surface joins.
 */
const ItemGroupSharedCardBody = React.memo(function ItemGroupSharedCardBody(props: Readonly<{
    children: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    virtualizedSegment?: ItemGroupVirtualizedSegment;
    containerStyle?: StyleProp<ViewStyle>;
    clipContent?: boolean;
    bare?: boolean;
}>) {
    const styles = stylesheet;
    const { virtualizedSegment } = props;
    if (props.bare) {
        return (
            <View
                accessibilityLabel={props.accessibilityLabel}
                aria-label={Platform.OS === 'web' ? props.accessibilityLabel : undefined}
                style={[styles.contentContainerBare, props.containerStyle]}
            >
                {props.children}
            </View>
        );
    }
    return (
        <GlassSurface surfaceGroup="card" nested finishRole="card"
            accessibilityRole={Platform.OS === 'web' ? undefined : props.accessibilityRole}
            accessibilityLabel={props.accessibilityLabel}
            aria-label={Platform.OS === 'web' ? props.accessibilityLabel : undefined}
            role={Platform.OS === 'web' ? props.accessibilityRole : undefined}
            style={[
                styles.contentContainerOuter,
                virtualizedSegment ? styles.virtualizedSurfaceSegment : undefined,
                virtualizedSegment?.first === false
                    ? styles.virtualizedSurfaceContinuesBefore
                    : undefined,
                virtualizedSegment?.last === false
                    ? styles.virtualizedSurfaceContinuesAfter
                    : undefined,
                props.containerStyle,
            ]}
        >
            <View style={[
                styles.contentContainerInner,
                props.clipContent ? styles.contentContainerInnerClipped : undefined,
                virtualizedSegment?.first === false
                    ? styles.virtualizedSurfaceContinuesBefore
                    : undefined,
                virtualizedSegment?.last === false
                    ? styles.virtualizedSurfaceContinuesAfter
                    : undefined,
            ]}>
                {withItemGroupDividers(props.children, virtualizedSegment)}
            </View>
        </GlassSurface>
    );
});

/**
 * A page section's body: its rows on the shared page sheet (`HappierPageSheet`, on the host palette),
 * the object plugin page sections draw too. The sheet decides the hairlines, gives its rows the sheet
 * anatomy (row inset, divider colour) and lays out `HappierPageSheetGroup`s; this adds the group's
 * accessible container, each row's position, and the joins of a virtualized section's chunks.
 */
const ItemGroupPageSheetBody = React.memo(function ItemGroupPageSheetBody(props: Readonly<{
    children: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    virtualizedSegment?: ItemGroupVirtualizedSegment;
    containerStyle?: StyleProp<ViewStyle>;
    clipContent?: boolean;
    /** `flat`: the same rows and hairlines laid on the pane, without the card. */
    flat?: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { virtualizedSegment } = props;
    // The same palette plugin pages draw with: one card, one row seam, no core-only override.
    const colors = React.useMemo(() => projectPluginUiHostPalette(theme), [theme]);
    return (
        <View
            accessibilityRole={Platform.OS === 'web' ? undefined : props.accessibilityRole}
            accessibilityLabel={props.accessibilityLabel}
            aria-label={Platform.OS === 'web' ? props.accessibilityLabel : undefined}
            role={Platform.OS === 'web' ? props.accessibilityRole : undefined}
        >
            <HappierPageSheet
                colors={colors}
                surface={props.flat ? 'none' : undefined}
                gradient={resolveThemeSurfaceFinish(theme, 'card')}
                renderMaterialSurface={renderThemeMaterialSurface}
                // App callers pass React Native layout styles; the shared sheet keeps its own look under them.
                style={[
                    styles.pageSheet,
                    // Without a card, the rows' glyphs and text start on the section heading's edge; the
                    // press fill and hairlines take the row padding into the margin.
                    props.flat ? styles.pageSheetFlat : undefined,
                    props.clipContent ? styles.contentContainerInnerClipped : undefined,
                    // A virtualized section's chunks read as one sheet: no grounding between them.
                    virtualizedSegment ? styles.virtualizedSurfaceSegment : undefined,
                    virtualizedSegment?.first === false ? styles.virtualizedSurfaceContinuesBefore : undefined,
                    virtualizedSegment?.last === false ? styles.virtualizedSurfaceContinuesAfter : undefined,
                    props.containerStyle,
                ] as HappierPageSheetProps['style']}
            >
                {withItemGroupSheetRows(props.children, virtualizedSegment)}
            </HappierPageSheet>
        </View>
    );
});

type ItemGroupRowProps = { showDivider?: boolean };

/**
 * The layout used by groups that asked for columns.
 *
 * ONE renderer, at every width and every row count. The resolved column count is
 * a measured, transient value, so it may only decide STYLE — never which
 * component renders a row, and never which container a row lives in. Rows are
 * always the direct cells of a single wrapping grid; collapsing to one column is
 * `flexBasis: '100%'` on those same cells, and the shared-card chrome moves onto
 * a surface View that is present in both states. A resize is therefore a pure
 * re-layout: every row keeps its identity, state, in-flight animation, expansion
 * and measured height.
 *
 * Collapsed to one column this is VISUALLY the shared card — same chrome, same
 * dividers, same row corners — but it is NOT the same tree: the grid root, one
 * cell View per row, and a per-row rounding View sit between the card and the
 * rows, and `contentContainerInner`'s radius lands per row instead of once. All
 * three are transparent, full-width and unclipped, so they move no pixel; they
 * are the price of never swapping renderers. What the group genuinely owes in
 * both states is its accessible name, which is why it is applied here too.
 *
 * Lives in its own component so the measurement — and the column-count state it
 * owns — is paid for ONLY by groups that actually asked for columns.
 */
const ItemGroupColumnedBody = React.memo(function ItemGroupColumnedBody(props: Readonly<{
    children: React.ReactNode;
    columns: number;
    accessibilityLabel?: string;
    containerStyle?: StyleProp<ViewStyle>;
    contentMarginPx?: number;
}>) {
    const styles = stylesheet;

    // The column count comes from THIS GROUP's own measured width, never from
    // `useWindowDimensions`: an ItemGroup is routinely a `flex: 1` pane beside a
    // fixed rail — settings panes, docked columns — where the window width is
    // unrelated to the room a row actually gets, and a narrow pane inside a wide
    // window would be dealt columns far below ITEM_GROUP_COLUMN_MIN_WIDTH_PX.
    // SelectionList reads the same resolver off its own container for the same
    // reason. Before the first layout there is no width, and the resolver falls
    // to one column rather than guessing from the viewport.
    //
    // The COUNT is the state, not the width. A web ResizeObserver reports a
    // fresh width for every sub-pixel reflow, and holding the raw number would
    // re-render the whole group each time for an identical layout. The width
    // lives in a ref because nothing renders it — it is only ever this
    // resolver's input.
    const measuredContentWidthRef = React.useRef<number | undefined>(undefined);
    const [widthColumns, setWidthColumns] = React.useState(1);
    const resolveColumnCountForContentWidth = React.useCallback((contentWidthPx: number | undefined): number => {
        if (contentWidthPx === undefined) return 1;
        return resolveItemGroupColumnCountForWidth({
            availableWidthPx: contentWidthPx,
            requestedColumns: props.columns,
        });
    }, [props.columns]);
    // Holding the count rather than the width would otherwise strand a stale
    // count whenever the resolver's OWN input moves — a caller narrowing
    // `columns`. No-op on mount, where both sides are already 1.
    React.useEffect(() => {
        const next = resolveColumnCountForContentWidth(measuredContentWidthRef.current);
        setWidthColumns((current) => (current === next ? current : next));
    }, [resolveColumnCountForContentWidth]);

    const contentMarginPx = props.contentMarginPx ?? Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 0;
    const handleMeasureLayout = React.useCallback((event: LayoutChangeEvent) => {
        const measuredWidthPx = event.nativeEvent.layout.width;
        if (!Number.isFinite(measuredWidthPx) || measuredWidthPx <= 0) return;
        // The cards sit inside the group's content margin on both edges, so what
        // the columns actually share is the measured box less those two insets.
        const contentWidthPx = measuredWidthPx - (2 * contentMarginPx);
        measuredContentWidthRef.current = contentWidthPx;
        const next = resolveColumnCountForContentWidth(contentWidthPx);
        setWidthColumns((current) => (current === next ? current : next));
    }, [contentMarginPx, resolveColumnCountForContentWidth]);

    const rows = React.useMemo(
        () => flattenItemGroupElementChildren(props.children),
        [props.children],
    );

    // A lone row (or a solitary empty state) must not render as a half-width
    // card next to dead space, and the count can never exceed the rows there are
    // to deal out. Both are layout facts about this render, so they land on the
    // resolved column count and stop there.
    const activeColumns = rows.length < 2 ? 1 : Math.min(widthColumns, rows.length);
    const isGrid = activeColumns > 1;

    // The gutter is per-cell PADDING rather than the grid's `columnGap`: a
    // percentage `flexBasis` plus a gap sums to more than 100% and wraps every
    // cell onto its own line. Half the gutter on each cell makes the gap between
    // two adjacent cards exactly ITEM_GROUP_COLUMN_GAP_PX, and the grid takes
    // the remainder of the content margin so the outer card edges still land
    // exactly where the single shared card's edges do.
    const cellGutterPx = isGrid ? ITEM_GROUP_COLUMN_GAP_PX / 2 : 0;
    const cellStyle = React.useMemo<ViewStyle>(() => ({
        flexBasis: `${100 / activeColumns}%`,
        paddingHorizontal: cellGutterPx,
    }), [activeColumns, cellGutterPx]);

    return (
        <View
            // The measuring host, and the group's accessibility container. It
            // carries no inset, so the width it reports is the same content box
            // in both column states: measuring the card itself would lose the
            // content margin at one column and oscillate across the breakpoint.
            style={styles.columnsMeasureHost}
            onLayout={handleMeasureLayout}
            accessibilityLabel={props.accessibilityLabel}
            aria-label={Platform.OS === 'web' ? props.accessibilityLabel : undefined}
        >
            <GlassSurface surfaceGroup="card" nested enabled={!isGrid} solidColor={isGrid ? 'transparent' : undefined} finishRole={isGrid ? null : 'card'}
                style={[
                    // Collapsed to one column the group IS the single shared card,
                    // so the chrome sits here — on a View that exists in both
                    // states — instead of on a second, competing body component.
                    isGrid ? undefined : styles.contentContainerOuter,
                    props.containerStyle,
                ]}
            >
                <ItemGroupColumns
                    activeColumns={activeColumns}
                    style={isGrid && contentMarginPx < cellGutterPx
                        ? [styles.columnsBody, { width: 'auto', marginHorizontal: contentMarginPx - cellGutterPx }]
                        : styles.columnsBody}
                    paddingHorizontal={isGrid ? Math.max(0, contentMarginPx - cellGutterPx) : 0}
                    paddingVertical={0}
                    columnGap={0}
                    rowGap={isGrid ? ITEM_GROUP_COLUMN_ROW_GAP_PX : 0}
                >
                    {rows.map((row, index) => {
                        const isLast = index === rows.length - 1;
                        // Each card is its own surface, so it is simultaneously
                        // first and last and draws no divider. Collapsed, the rows
                        // share one surface again and the dividers come back.
                        const showDivider = isGrid
                            ? false
                            : !isLast && (row.props as ItemGroupRowProps).showDivider !== false;
                        return (
                            <View
                                key={row.key ?? `item-group-cell-${index}`}
                                style={[styles.columnCell, cellStyle]}
                            >
                                <GlassSurface surfaceGroup="card" nested enabled={isGrid} solidColor={isGrid ? undefined : 'transparent'} finishRole={isGrid ? 'card' : null} style={isGrid ? styles.columnCardOuter : styles.contentContainerInner}>
                                    <ItemGroupRowPositionProvider
                                        value={isGrid
                                            ? { isFirst: true, isLast: true }
                                            : { isFirst: index === 0, isLast }}
                                    >
                                        {React.cloneElement(row, { showDivider } as ItemGroupRowProps)}
                                    </ItemGroupRowPositionProvider>
                                </GlassSurface>
                            </View>
                        );
                    })}
                </ItemGroupColumns>
            </GlassSurface>
        </View>
    );
});

/**
 * The surface a section takes when it does not choose one. A page hosted in a side pane (Session Info
 * beside its conversation, lab csinfo I2) lays its sections flat on the pane — rows and hairlines, no
 * card — so it reads as the pane's own content rather than a page of cards squeezed beside a page.
 */
const ItemGroupDefaultSurfaceContext = React.createContext<'sheet' | 'flat'>('sheet');

export function ItemGroupDefaultSurfaceProvider(props: Readonly<{ value: 'sheet' | 'flat'; children?: React.ReactNode }>) {
    return <ItemGroupDefaultSurfaceContext.Provider value={props.value}>{props.children}</ItemGroupDefaultSurfaceContext.Provider>;
}

export const ItemGroup = React.memo<ItemGroupProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const maxWidth = useLayoutMaxWidth();

    const presentation = useListPresentation();
    const isPage = presentation === 'page';
    // A contained scope (a column or widget body that owns its padding) adds no second inset, page or grouped.
    const contained = usePageListInsets() === 'contained';
    const {
        title,
        description,
        action,
        actionLayout,
        titleAccessory,
        titleLeading,
        children,
        accessibilityRole,
        accessibilityLabel,
        style,
        headerStyle,
        titleStyle,
        containerStyle,
        constrainToContentWidth = true,
        selectableItemCountOverride,
        virtualizedSegment,
        columns,
        clipContent = false,
        surface: surfaceProp,
        density,
        testID,
    } = props;
    const defaultSurface = React.useContext(ItemGroupDefaultSurfaceContext);
    const floatingSurface = useFloatingListSurface();
    const inspector = usePageRowDensityOverride() === 'inspector';
    const renderPageDescription = (content: React.ReactNode) => (
        <Text style={[styles.pageDescription, inspector ? styles.pageDescriptionInspector : null]}>{content}</Text>
    );
    // Only page sections that choose no surface take it: menus and pickers opened from the pane reset to
    // grouped rows, and a section laid out as its own surface (`none`) stays as it is.
    const surface = surfaceProp ?? 'sheet';
    const flatSheet = surfaceProp === undefined && isPage && defaultSurface === 'flat';
    const resolvedAccessibilityLabel = accessibilityLabel ?? (typeof title === 'string' ? title : undefined);
    // Bare rows in a contained scope (a widget body or flow, grouped or page) bleed by their own padding: their
    // marks and titles keep the column's edge (the frame header's mark, a flow's Name and section titles), while
    // the press fill and dividers reach into the column's padding.
    const groupedRowPaddingPx = ITEM_ROW_PADDING_HORIZONTAL[useResolvedItemDensity(density)];
    const rowPaddingPx = isPage ? PAGE_LIST_METRICS.rowPaddingHorizontalPx : groupedRowPaddingPx;
    const bleedRows = contained && surface === 'none';
    const resolvedContainerStyle = contained
        ? [styles.containedContent, bleedRows ? { marginHorizontal: -rowPaddingPx } : null, containerStyle]
        : containerStyle;

    const wantsColumns = (columns ?? 1) > 1;
    // A section on a popover, menu or its phone sheet, carded or not: a floating surface draws no card, so
    // both take the menu anatomy and every row there shares the menu's text edge (a flat group kept the
    // grouped margin and sat 12 px in from the carded rows beside it). A column grid, a virtualized chunk
    // or a contained scope keeps its own composition.
    const floatingMenuSection = floatingSurface && !isPage && !contained && (surface === 'sheet' || surface === 'none')
        && !wantsColumns && !virtualizedSegment;
    if (wantsColumns && clipContent) {
        throw new Error('ItemGroup clipContent cannot be combined with columns');
    }
    resolveHappierItemGroupConstraints({
        role: accessibilityRole,
        accessibilityLabel: resolvedAccessibilityLabel,
        columns: columns ?? 1,
        virtualized: Boolean(virtualizedSegment),
    });

    const selectableItemCount = React.useMemo(() => {
        if (typeof selectableItemCountOverride === 'number') {
            return selectableItemCountOverride;
        }
        return countSelectableItems(children);
    }, [children, selectableItemCountOverride]);

    if (floatingMenuSection) {
        return (
            <View testID={testID} style={[styles.menuSection, style]}>
                {props.header === 'none' ? null : typeof title === 'string'
                    ? <SelectionListSectionHeader title={title} />
                    : title ?? null}
                <MenuSectionRowsContext.Provider value={true}>
                    {/* Free content (a button row, a details head) stands on the menu rows' text edge, as rows bring
                        their own padding: `BareSectionContent` takes this inset back. */}
                    <BareRowBleedContext.Provider value={MENU_ROW_METRICS.paddingHorizontalPx}>
                    <SectionItemDensityProvider value={density}>
                        <HappierItemGroupBehavior
                            accessibilityRole={accessibilityRole}
                            accessibilityLabel={resolvedAccessibilityLabel}
                            selectableItemCount={selectableItemCount}
                            renderContent={(projectedChildren) => (
                                <View
                                    accessibilityRole={Platform.OS === 'web' ? undefined : accessibilityRole}
                                    accessibilityLabel={resolvedAccessibilityLabel}
                                    aria-label={Platform.OS === 'web' ? resolvedAccessibilityLabel : undefined}
                                    role={Platform.OS === 'web' ? accessibilityRole : undefined}
                                    style={[styles.menuSectionRows, containerStyle]}
                                >
                                    {projectedChildren}
                                </View>
                            )}
                        >
                            {children}
                        </HappierItemGroupBehavior>
                    </SectionItemDensityProvider>
                    </BareRowBleedContext.Provider>
                </MenuSectionRowsContext.Provider>
                {description ? (
                    <View style={styles.menuSectionDescription}>
                        <Text style={styles.menuSectionDescriptionText}>{description}</Text>
                    </View>
                ) : null}
            </View>
        );
    }

    return (
        <View testID={testID} style={[styles.wrapper, style]}>
            <View style={[styles.container, contained ? styles.containedContainer : null, constrainToContentWidth ? { maxWidth } : undefined]}>
                {/* Header */}
                {props.header === 'none' ? null : isPage && (title || description || action) ? (
                    <HappierPageSectionHeader
                        title={(titleAccessory || titleLeading) && typeof title === 'string' ? (
                            <View style={styles.pageTitleRow}>
                                {/* The mark stays beside the first line of its name; only the accessory wraps below. */}
                                <View style={styles.pageTitleName}>
                                    {titleLeading}
                                    <Text accessibilityRole="header" style={[styles.pageTitle, styles.pageTitleText, titleStyle]}>{title}</Text>
                                </View>
                                {titleAccessory}
                            </View>
                        ) : title}
                        description={description}
                        action={action ?? undefined}
                        actionLayout={actionLayout}
                        insetPx={contained ? 0 : (Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 12) + PAGE_LIST_METRICS.headingOpticalInsetPx}
                        renderText={(input) => input.role === 'sectionTitle'
                            ? <Text accessibilityRole="header" style={[styles.pageTitle, titleStyle]}>{input.text}</Text>
                            : renderPageDescription(input.text)}
                        // App callers pass React Native layout styles; the shared header keeps its own anatomy under them.
                        style={[inspector ? styles.pageHeaderInspector : null, headerStyle] as HappierPageSectionHeaderProps['style']}
                    />
                ) : isPage ? (
                    virtualizedSegment?.first !== false ? <View style={[styles.pageHeaderNoTitle, inspector ? styles.pageHeaderNoTitleInspector : null, headerStyle]} /> : null
                ) : title ? (
                    <View style={[styles.header, headerStyle]}>
                        {typeof title === 'string' ? (
                            <Eyebrow style={[styles.headerText, titleStyle]}>
                                {title}
                            </Eyebrow>
                        ) : (
                            title
                        )}
                    </View>
                ) : virtualizedSegment?.first !== false ? (
                    // Add top margin when there's no title
                    <View style={[styles.headerNoTitle, headerStyle]} />
                ) : null}

                {/* Content Container. A page section decides its rows' leading column once; only page
                    rows register with it (see `sectionLeadingColumn.tsx`). */}
                <SectionLeadingColumnProvider>
                <SectionItemDensityProvider value={density}>
                <BareRowBleedContext.Provider value={bleedRows ? rowPaddingPx : 0}>
                    <HappierItemGroupBehavior
                        accessibilityRole={accessibilityRole}
                        accessibilityLabel={resolvedAccessibilityLabel}
                        selectableItemCount={selectableItemCount}
                        renderContent={(projectedChildren) => wantsColumns ? (
                            <ItemGroupColumnedBody
                                columns={columns ?? 1}
                                accessibilityLabel={resolvedAccessibilityLabel}
                                containerStyle={resolvedContainerStyle}
                                contentMarginPx={contained ? 0 : undefined}
                            >
                                {projectedChildren}
                            </ItemGroupColumnedBody>
                        ) : isPage && surface === 'sheet' ? (
                            <ItemGroupPageSheetBody
                                accessibilityRole={accessibilityRole}
                                accessibilityLabel={resolvedAccessibilityLabel}
                                virtualizedSegment={virtualizedSegment}
                                containerStyle={resolvedContainerStyle}
                                clipContent={clipContent}
                                flat={flatSheet}
                            >
                                {projectedChildren}
                            </ItemGroupPageSheetBody>
                        ) : (
                            <ItemGroupSharedCardBody
                                accessibilityRole={accessibilityRole}
                                accessibilityLabel={resolvedAccessibilityLabel}
                                virtualizedSegment={virtualizedSegment}
                                containerStyle={resolvedContainerStyle}
                                clipContent={clipContent}
                                bare={surface === 'none'}
                            >
                                {projectedChildren}
                            </ItemGroupSharedCardBody>
                        )}
                    >
                        {children}
                    </HappierItemGroupBehavior>
                </BareRowBleedContext.Provider>
                </SectionItemDensityProvider>
                </SectionLeadingColumnProvider>

                {/* Footer (grouped presentation only; a page reads it as the section description) */}
                {!isPage && description && (
                    // A contained footer sits on the rows' text edge, one row inset in from the card.
                    <View style={[styles.footer, contained ? { paddingHorizontal: rowPaddingPx } : null]}>
                        <Text style={styles.footerText}>
                            {description}
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
});
