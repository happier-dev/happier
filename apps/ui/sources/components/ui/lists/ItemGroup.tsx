import * as React from 'react';
import {
    View,
    StyleProp,
    ViewStyle,
    TextStyle,
    Platform,
    type LayoutChangeEvent,
} from 'react-native';
import { shadowLevelStyle } from '@/shadowElevation';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    flattenItemGroupElementChildren,
    withItemGroupDividers,
    type ItemGroupVirtualizedSegment,
} from './ItemGroup.dividers';
import { ItemGroupRowPositionProvider } from './ItemGroupRowPosition';
import { countSelectableItems } from './ItemGroup.selectableCount';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { ItemGroupColumns } from './ItemGroupColumns';
import {
    ITEM_GROUP_COLUMN_GAP_PX,
    ITEM_GROUP_COLUMN_ROW_GAP_PX,
    resolveItemGroupColumnCountForWidth,
} from './itemGroupColumnLayout';
import {
    ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX,
    ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX,
    ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX,
} from './itemGroupSpacing';
import { Text } from '@/components/ui/text/Text';
import {
    HappierItemGroupBehavior,
    HappierItemGroupSelectionContext,
    resolveHappierItemGroupConstraints,
} from '@happier-dev/plugin-ui/presentation';


export { withItemGroupDividers } from './ItemGroup.dividers';

export { HappierItemGroupSelectionContext as ItemGroupSelectionContext } from '@happier-dev/plugin-ui/presentation';

export interface ItemGroupProps {
    title?: string | React.ReactNode;
    footer?: string;
    children: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    footerTextStyle?: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    constrainToContentWidth?: boolean;
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
     * Performance: when you already know how many selectable rows are inside the group,
     * pass this to avoid walking the full React children tree on every render.
     */
    selectableItemCountOverride?: number;
}

const stylesheet = StyleSheet.create((theme) => {
    const surfaceChromeStyle = resolveThemeSurfaceChromeStyle({
        borderColor: theme.colors.border.surface,
        highlightColor: theme.colors.effect.surfaceHighlight,
        shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[1]),
    });

    // ONE card-chrome definition, shared by the single shared card and by each
    // standalone card in the multi-column layout, so the two can never drift.
    const cardChrome = {
        backgroundColor: theme.colors.surface.base,
        borderRadius: Platform.select({ ios: 10, default: 16 }),
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
        header: {
            paddingTop: Platform.select({ ios: 26, default: 20 }),
            paddingBottom: Platform.select({ ios: 8, default: 8 }),
            paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        },
        headerNoTitle: {
            paddingTop: Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX),
        },
        headerText: {
            ...Typography.default('regular'),
            color: theme.colors.text.secondary,
            fontSize: Platform.select({ ios: 13, default: 14 }),
            lineHeight: Platform.select({ ios: 18, default: 20 }),
            letterSpacing: -0.08,
            textTransform: 'uppercase'
        },
        contentContainerOuter: {
            ...cardChrome,
            marginHorizontal: Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX),
        },
        contentContainerInner: {
            borderRadius: Platform.select({ ios: 10, default: 16 }),
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
        footer: {
            paddingTop: Platform.select({ ios: 6, default: 8 }),
            paddingBottom: Platform.select({ ios: 8, default: 16 }),
            paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        },
        footerText: {
            ...Typography.default('regular'),
            color: theme.colors.text.secondary,
            fontSize: Platform.select({ ios: 13, default: 14 }),
            lineHeight: Platform.select({ ios: 18, default: 20 }),
            letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
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
}>) {
    const styles = stylesheet;
    const { virtualizedSegment } = props;
    return (
        <View
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
                virtualizedSegment?.first === false
                    ? styles.virtualizedSurfaceContinuesBefore
                    : undefined,
                virtualizedSegment?.last === false
                    ? styles.virtualizedSurfaceContinuesAfter
                    : undefined,
            ]}>
                {withItemGroupDividers(props.children, virtualizedSegment)}
            </View>
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

    const contentMarginPx = Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX) ?? 0;
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
            <View
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
                    style={styles.columnsBody}
                    paddingHorizontal={isGrid ? contentMarginPx - cellGutterPx : 0}
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
                                <View style={isGrid ? styles.columnCardOuter : styles.contentContainerInner}>
                                    <ItemGroupRowPositionProvider
                                        value={isGrid
                                            ? { isFirst: true, isLast: true }
                                            : { isFirst: index === 0, isLast }}
                                    >
                                        {React.cloneElement(row, { showDivider } as ItemGroupRowProps)}
                                    </ItemGroupRowPositionProvider>
                                </View>
                            </View>
                        );
                    })}
                </ItemGroupColumns>
            </View>
        </View>
    );
});

export const ItemGroup = React.memo<ItemGroupProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const maxWidth = useLayoutMaxWidth();

    const {
        title,
        footer,
        children,
        accessibilityRole,
        accessibilityLabel,
        style,
        headerStyle,
        footerStyle,
        titleStyle,
        footerTextStyle,
        containerStyle,
        constrainToContentWidth = true,
        selectableItemCountOverride,
        virtualizedSegment,
        columns,
    } = props;

    const wantsColumns = (columns ?? 1) > 1;
    resolveHappierItemGroupConstraints({
        role: accessibilityRole,
        accessibilityLabel,
        columns: columns ?? 1,
        virtualized: Boolean(virtualizedSegment),
    });

    const selectableItemCount = React.useMemo(() => {
        if (typeof selectableItemCountOverride === 'number') {
            return selectableItemCountOverride;
        }
        return countSelectableItems(children);
    }, [children, selectableItemCountOverride]);

    return (
        <View style={[styles.wrapper, style]}>
            <View style={[styles.container, constrainToContentWidth ? { maxWidth } : undefined]}>
                {/* Header */}
                {title ? (
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
                    <View style={styles.headerNoTitle} />
                ) : null}

                {/* Content Container */}
                <HappierItemGroupBehavior
                    accessibilityRole={accessibilityRole}
                    accessibilityLabel={accessibilityLabel}
                    selectableItemCount={selectableItemCount}
                    renderContent={(projectedChildren) => wantsColumns ? (
                        <ItemGroupColumnedBody
                            columns={columns ?? 1}
                            accessibilityLabel={accessibilityLabel}
                            containerStyle={containerStyle}
                        >
                            {projectedChildren}
                        </ItemGroupColumnedBody>
                    ) : (
                        <ItemGroupSharedCardBody
                            accessibilityRole={accessibilityRole}
                            accessibilityLabel={accessibilityLabel}
                            virtualizedSegment={virtualizedSegment}
                            containerStyle={containerStyle}
                        >
                            {projectedChildren}
                        </ItemGroupSharedCardBody>
                    )}
                >
                    {children}
                </HappierItemGroupBehavior>

                {/* Footer */}
                {footer && (
                    <View style={[styles.footer, footerStyle]}>
                        <Text style={[styles.footerText, footerTextStyle]}>
                            {footer}
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
});
