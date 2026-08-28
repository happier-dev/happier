import * as React from 'react';
import { View, StyleProp, ViewStyle, TextStyle, Platform, useWindowDimensions } from 'react-native';
import { shadowLevelStyle } from '@/shadowElevation';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { withItemGroupDividers, withItemGroupStandaloneRows } from './ItemGroup.dividers';
import { countSelectableItems } from './ItemGroup.selectableCount';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { ItemGroupColumn, ItemGroupColumns } from './ItemGroupColumns';
import {
    ITEM_GROUP_COLUMN_GAP_PX,
    ITEM_GROUP_COLUMN_ROW_GAP_PX,
    partitionItemsIntoColumns,
    resolveItemGroupColumnCountForWidth,
} from './itemGroupColumnLayout';
import {
    ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX,
    ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX,
    resolveItemGroupContentHorizontalInsetPx,
} from './itemGroupSpacing';
import { Text } from '@/components/ui/text/Text';


export { withItemGroupDividers } from './ItemGroup.dividers';

export const ItemGroupSelectionContext = React.createContext<{ selectableItemCount: number } | null>(null);

export interface ItemGroupProps {
    title?: string | React.ReactNode;
    footer?: string;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    footerTextStyle?: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    constrainToContentWidth?: boolean;
    /**
     * Clip edge-to-edge child surfaces to this card's rounded inner boundary.
     * The outer chrome remains overflow-visible so shadows and anchored overlays are unaffected.
     */
    clipContent?: boolean;
    /**
     * Lay the rows out as a grid of standalone cards instead of one shared card,
     * up to this many columns. Collapses back to the single shared card whenever
     * the available width cannot give every column a usable minimum width, so
     * phones and narrow panes are unaffected.
     */
    columns?: 1 | 2 | 3;
    /**
     * Performance: when you already know how many selectable rows are inside the group,
     * pass this to avoid walking the full React children tree on every render.
     */
    selectableItemCountOverride?: number;
}

const stylesheet = StyleSheet.create((theme, runtime) => {
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
            paddingTop: Platform.select({ ios: 20, default: 16 }),
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
        contentContainerInnerClipped: {
            overflow: 'hidden',
        },
        // NOTE: no `marginHorizontal` here. The columns root is `width: '100%'`,
        // and margin sits OUTSIDE a resolved width — the grid would occupy
        // 100% + 2*margin and overrun the single card's box. The matching inset
        // is applied as PADDING via the `paddingHorizontal` prop instead.
        columnsBody: {
            width: '100%',
        },
        columnStack: {
            width: '100%',
            gap: ITEM_GROUP_COLUMN_ROW_GAP_PX,
        },
        columnCardOuter: cardChrome,
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

/** The default layout: every row inside one shared card, separated by dividers. */
const ItemGroupSharedCardBody = React.memo(function ItemGroupSharedCardBody(props: Readonly<{
    children: React.ReactNode;
    containerStyle?: StyleProp<ViewStyle>;
    clipContent?: boolean;
}>) {
    const styles = stylesheet;
    return (
        <View style={[styles.contentContainerOuter, props.containerStyle]}>
            <View style={[styles.contentContainerInner, props.clipContent ? styles.contentContainerInnerClipped : undefined]}>
                {withItemGroupDividers(props.children)}
            </View>
        </View>
    );
});

/**
 * The multi-column layout: each row becomes its own card, distributed
 * round-robin into independent column stacks.
 *
 * Lives in its own component so `useWindowDimensions` — and the re-render on
 * every window resize that comes with it — is subscribed ONLY by groups that
 * actually asked for columns, never by every ItemGroup in the app.
 */
const ItemGroupColumnedBody = React.memo(function ItemGroupColumnedBody(props: Readonly<{
    children: React.ReactNode;
    columns: number;
    maxWidth: number;
    containerStyle?: StyleProp<ViewStyle>;
    clipContent?: boolean;
}>) {
    const styles = stylesheet;
    const { width: windowWidth } = useWindowDimensions();

    // The group is always full-bleed inside its scroll container, so the content
    // width it will actually get is the window width capped by the user's
    // content-width preference, less the group's own horizontal insets. The
    // inset helper is a PER-SIDE value (it is consumed as `paddingHorizontal`
    // elsewhere), so both edges have to come off the available width.
    const availableWidthPx = Math.min(windowWidth, props.maxWidth)
        - (2 * resolveItemGroupContentHorizontalInsetPx());
    const widthColumns = resolveItemGroupColumnCountForWidth({
        availableWidthPx,
        requestedColumns: props.columns,
    });

    const columnStacks = React.useMemo(() => {
        if (widthColumns <= 1) return null;
        const rows = withItemGroupStandaloneRows(props.children);
        // A lone row (or a solitary empty state) must not render as a half-width
        // card next to dead space — fall back to the full-width shared card.
        if (rows.length < 2) return null;
        return partitionItemsIntoColumns(rows, Math.min(widthColumns, rows.length));
    }, [widthColumns, props.children]);

    if (!columnStacks) {
        return (
            <ItemGroupSharedCardBody containerStyle={props.containerStyle} clipContent={props.clipContent}>
                {props.children}
            </ItemGroupSharedCardBody>
        );
    }

    return (
        <ItemGroupColumns
            activeColumns={columnStacks.length}
            style={[styles.columnsBody, props.containerStyle]}
            paddingHorizontal={Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX)}
            paddingVertical={0}
            columnGap={ITEM_GROUP_COLUMN_GAP_PX}
            rowGap={ITEM_GROUP_COLUMN_ROW_GAP_PX}
        >
            {columnStacks.map((rows, columnIndex) => (
                <ItemGroupColumn key={`item-group-column-${columnIndex}`}>
                    <View style={styles.columnStack}>
                        {rows.map((row, rowIndex) => (
                            <View
                                key={row.key ?? `item-group-card-${columnIndex}-${rowIndex}`}
                                style={styles.columnCardOuter}
                            >
                                <View style={[styles.contentContainerInner, props.clipContent ? styles.contentContainerInnerClipped : undefined]}>
                                    {row}
                                </View>
                            </View>
                        ))}
                    </View>
                </ItemGroupColumn>
            ))}
        </ItemGroupColumns>
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
        style,
        headerStyle,
        footerStyle,
        titleStyle,
        footerTextStyle,
        containerStyle,
        constrainToContentWidth = true,
        clipContent = false,
        selectableItemCountOverride
    } = props;

    const selectableItemCount = React.useMemo(() => {
        if (typeof selectableItemCountOverride === 'number') {
            return selectableItemCountOverride;
        }
        return countSelectableItems(children);
    }, [children, selectableItemCountOverride]);

    const selectionContextValue = React.useMemo(() => {
        return { selectableItemCount };
    }, [selectableItemCount]);

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
                ) : (
                    // Add top margin when there's no title
                    <View style={styles.headerNoTitle} />
                )}

                {/* Content Container */}
                <ItemGroupSelectionContext.Provider value={selectionContextValue}>
                    {(props.columns ?? 1) > 1 ? (
                        <ItemGroupColumnedBody
                            columns={props.columns ?? 1}
                            maxWidth={constrainToContentWidth ? maxWidth : Number.POSITIVE_INFINITY}
                            containerStyle={containerStyle}
                            clipContent={clipContent}
                        >
                            {children}
                        </ItemGroupColumnedBody>
                    ) : (
                        <ItemGroupSharedCardBody containerStyle={containerStyle} clipContent={clipContent}>
                            {children}
                        </ItemGroupSharedCardBody>
                    )}
                </ItemGroupSelectionContext.Provider>

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
