import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_COLLECTION_LIST_ROW_STYLE,
    HAPPIER_PAGE_METRICS,
    HAPPIER_COLLECTION_LIST_METRICS,
    HAPPIER_COLLECTION_LIST_TEXT,
    resolveHappierCollectionListRowPadding,
    resolveHappierCollectionTreeChildIndentPx,
    useHappierCollectionListRow,
    HappierCollectionList,
    HappierDisclosureChevron,
    HappierTreeDisclosure,
    HappierCollectionListGroupLabel,
    useHappierCollectionDraftRowTitle,
    type HappierCollectionDraftTitleStore,
    type HappierCollectionListHost,
    type HappierCollectionListProps,
    type HappierCollectionRowRole,
} from '@happier-dev/plugin-ui/presentation';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

/**
 * Happier core's binding of the Collection `list` presentation: the app's own text, grouped list
 * surface, compact search field and theme tokens. The anatomy, its geometry and its rules live in
 * `@happier-dev/plugin-ui` (`HappierCollectionList`); this file only supplies host primitives.
 */
/** A list text step in core's own family for its weight. */
function listText(role: keyof typeof HAPPIER_COLLECTION_LIST_TEXT) {
    const step = HAPPIER_COLLECTION_LIST_TEXT[role];
    return {
        ...Typography.default(step.weight),
        fontSize: step.fontSize,
        lineHeight: step.lineHeight,
    };
}

import type { NavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { PhoneDestinationBackLine } from '@/components/ui/layout/usePageBackControl';
import { useNavigationLeavesLargeTitle } from '@/components/ui/layout/navigationTitleChrome';

const styles = StyleSheet.create((theme) => ({
    // A line state (a failed read) on the rows' text edge, between the list's rows.
    stateLine: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset, paddingVertical: theme.space.s4 },
    surface: {
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
    // A list that is the whole page names it as every phone page does.
    pageTitle: {
        ...Typography.variant('display'),
        color: theme.colors.text.primary,
        // On the page's edge, where every phone page's title stands, not the rows' text edge.
        marginLeft: HAPPIER_PAGE_METRICS.pageTextInsetPx - HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    },
    // A navigation column beside the page (the app shell's column) lies on the column's plane
    // (`appShellColumnSurface`): the list draws no ground of its own there.
    plane: {
        backgroundColor: 'transparent',
    },
    title: {
        ...listText('title'),
        color: theme.colors.text.primary,
    },
    count: {
        ...listText('count'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    subtitle: {
        ...listText('subtitle'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    groupTitle: {
        ...listText('groupTitle'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    // A group label inside a page section's sheet: the group's sub-heading, in the text tone.
    groupHeading: {
        ...listText('groupHeading'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    groupCount: {
        ...listText('groupCount'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    dimmedTitle: {
        color: theme.colors.text.secondary,
    },
    // A tree row's mark, in the glyph box; on hover or keyboard focus its disclosure takes the same box.
    treeMark: {
        width: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
        alignItems: 'center',
        justifyContent: 'center',
    },
    treeMarkLeading: {
        alignItems: 'flex-start',
    },
    // The row's end column: the status slot, then the quiet count, on one right edge.
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    trailingCount: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    // A path under a row's title (the open checkout's folder): mono, at the subtitle's size.
    monoSubtitle: {
        ...Typography.mono(),
    },
    troubleDot: {
        width: HAPPIER_COLLECTION_LIST_METRICS.troubleDotSize,
        height: HAPPIER_COLLECTION_LIST_METRICS.troubleDotSize,
        borderRadius: HAPPIER_COLLECTION_LIST_METRICS.troubleDotSize / 2,
        backgroundColor: theme.colors.state.warning.foreground,
    },
    // The plane's selected chip: `Item`'s own `surface.selected` is the plane's colour, so an open
    // navigation row lifts to the elevated surface (the plugin realm's `navigationSelected`).
    navigationRowSelected: {
        backgroundColor: theme.colors.surface.elevated,
    },
    // The chip is ~1.06:1 against the plane, below WCAG 1.4.11's 3:1, so the title's weight carries
    // the state as well.
    navigationRowTitleSelected: {
        ...listText('rowTitleSelected'),
    },
}));

const textRoleStyles = {
    title: styles.title,
    count: styles.count,
    subtitle: styles.subtitle,
    groupTitle: styles.groupTitle,
    groupHeading: styles.groupHeading,
    groupCount: styles.groupCount,
} as const;

const collectionListHost: HappierCollectionListHost = {
    Text: (props) => (
        <Text
            style={textRoleStyles[props.role]}
            {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
            {...(props.accessibilityRole === undefined ? {} : { accessibilityRole: props.accessibilityRole })}
            {...(props.testID === undefined ? {} : { testID: props.testID })}
        >
            {props.children}
        </Text>
    ),
    Scroller: (props) => <ItemList presentation="grouped" style={props.style as StyleProp<ViewStyle>}>{props.children}</ItemList>,
    SearchField: (props) => (
        <CompactSearchField
            value={props.value}
            onChangeText={props.onChangeText}
            placeholder={props.placeholder}
            style={props.style as StyleProp<ViewStyle>}
            {...(props.trailing == null ? {} : { trailing: props.trailing })}
            {...(props.anchorRef === undefined ? {} : { anchorRef: props.anchorRef as React.RefObject<View | null> })}
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            {...(props.autoFocus ? { autoFocus: true } : {})}
        />
    ),
    // A column's Search icon, drawn like the Sessions header's and the filter beside it; selected while open.
    SearchToggle: (props) => (
        <IconButton
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            accessibilityLabel={props.accessibilityLabel}
            tooltip={props.accessibilityLabel}
            variant="plain"
            iconSize={ICON_SIZE.sm}
            selected={props.open}
            iconName="magnifying-glass"
            onPress={props.onPress}
        />
    ),
    surfaceStyle: styles.surface,
    useGroupGlyphColor: useCollectionListGroupGlyphColor,
};

/** A group label's own glyphs (its disclosure chevron): the quiet tertiary ink of its count. */
function useCollectionListGroupGlyphColor(): string {
    return useUnistyles().theme.colors.text.tertiary;
}

const collectionListPlaneHost: HappierCollectionListHost = { ...collectionListHost, surfaceStyle: styles.plane };

const collectionListPhonePageHost: HappierCollectionListHost = {
    ...collectionListHost,
    Text: (props) => props.role === 'title' ? (
        <Text style={styles.pageTitle} accessibilityRole="header" {...(props.testID === undefined ? {} : { testID: props.testID })}>{props.children}</Text>
    ) : <collectionListHost.Text {...props} />,
};

/**
 * How many items a list holds before its header offers the search field (`search` is "present only when
 * the list is long enough to need it"). A list whose whole length is not yet known counts as long.
 */
export const COLLECTION_LIST_SEARCH_THRESHOLD = 8;

/**
 * The list pane of a list + detail collection. Rows are compact `Item`s with `collectionListStyles.row`.
 * `surface="plane"` is the list as a navigation column on the shell's plane; its rows are
 * {@link CollectionNavigationRow}s (the plane's selected chip).
 */
export const CollectionList = React.memo(function CollectionList(props: Omit<HappierCollectionListProps, 'host'> & Readonly<{
    surface?: 'page' | 'plane';
    /** The way out of a list that is the whole page, on its own line above the title (`usePhoneDestinationBack`). */
    pageBack?: NavigationBackControl | null;
}>) {
    const { surface, toolsInsetPx, pageBack: PageBack, ...listProps } = props;
    const largeTitle = useNavigationLeavesLargeTitle();
    const pageToolsInsetPx = React.useContext(CollectionPageToolsInsetContext);
    const resolvedToolsInsetPx = toolsInsetPx ?? pageToolsInsetPx;
    return (
        <>
            <PhoneDestinationBackLine control={PageBack ?? null} />
            <HappierCollectionList
                host={surface === 'plane' ? collectionListPlaneHost : PageBack || largeTitle ? collectionListPhonePageHost : collectionListHost}
                {...(resolvedToolsInsetPx === undefined ? {} : { toolsInsetPx: resolvedToolsInsetPx })}
                {...listProps}
            />
        </>
    );
});

/**
 * A page that lists under its own title (a phone's settings collection) provides its gutter here, so every
 * list inside starts its search field and filters on that edge instead of the column's.
 */
export const CollectionPageToolsInsetContext = React.createContext<number | undefined>(undefined);

/**
 * A group heading inside a collection list: what the rows share, and how many there are. A navigation
 * column's groups may fold (`disclosure`), carry their own hover actions and a collapsed rollup.
 */
export function CollectionListGroupLabel(props: Omit<React.ComponentProps<typeof HappierCollectionListGroupLabel>, 'host'>) {
    return <HappierCollectionListGroupLabel host={collectionListHost} {...props} />;
}

/**
 * One navigation row in a column (Settings, Plugins, a Home console, settings search results): core's
 * binding of the list anatomy's row — the same gutter, content inset, chip and heavier open title a
 * plugin's `NavigationList.Row` draws through `HappierListItem`. `leftElement` replaces the icon where
 * the row discloses children.
 */
export const CollectionNavigationRow = React.memo(function CollectionNavigationRow(props: Readonly<{
    /** A navigable destination: workspace menu, pointer and drag intent share the workspace owner. */
    href?: string | null;
    testID: string;
    title: string;
    subtitle?: string;
    /** Navigation keeps its compact role even when it has a descriptive subtitle. */
    rowRole?: Exclude<HappierCollectionRowRole, 'catalogRow'>;
    /** An inline mark before the subtitle: the collection's trouble dot when the row needs the person. */
    subtitleLeading?: React.ReactNode;
    /** An inline mark on the title's line, after the title and its qualifier. */
    titleAccessory?: React.ReactNode;
    /** A quiet qualifier on the title's line, after the title (a project's Team, a folded machine). */
    titleQualifier?: string | null;
    /** The subtitle is a path: drawn in the mono face. */
    subtitleMono?: boolean;
    /** A row that is there but not active (an offline machine's last-known checkout, a saved source not open). */
    dimmed?: boolean;
    /** A tree item's semantics and roving focus, from the shared tree interaction owner (a column tree). */
    treeItem?: Pick<ItemProps, 'webRole' | 'webTabIndex' | 'accessibilityLevel' | 'accessibilityExpanded' | 'accessibilityPositionInSet' | 'accessibilitySetSize' | 'pressableRef' | 'onFocus' | 'onBlur' | 'onKeyDown'>;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    leftElementWhenHovered?: React.ReactNode;
    /** A quiet value at the row's end (a count, an age). */
    detail?: string;
    /**
     * The row's status slot at its end (lab `clstatus`): a work state's glyph or the live work mark, in place
     * of `detail` while the state speaks. It is part of the row's press; the row's name says the state.
     */
    status?: React.ReactNode;
    selected: boolean;
    /** A disclosed level's indent, added to the content inset. */
    indentPx?: number;
    /**
     * A disclosure tree (a service and its accounts): the row's bare mark (`icon`), replaced by the disclosure
     * turning with `expanded` while the row is hovered or focused. `null`: a leaf that never discloses.
     * With `onToggle` the row is a destination of its own (a Project): its press opens it, its mark stays on the
     * leading edge, and the disclosure is its own target at the row's end, after the count. Leaves draw none
     * and reserve nothing, so every mark keeps the column's text edge (owner 11-08).
     */
    disclosure?: Readonly<{ expanded: boolean; onToggle?: () => void }> | null;
    /** A disclosed child: one step in, its own mark starting where its parent's mark ends. */
    child?: boolean;
    /**
     * What the row lies on. `plane` (default): a navigation column on the shell's plane, whose open row lifts to
     * the elevated chip with a heavier title. `page`: a collection column on the page surface (a Settings rail),
     * whose open row takes the soft selection fill.
     */
    surface?: 'plane' | 'page';
    /** A quiet count at the row's end, after the status slot (a service's accounts, a pool's members). */
    count?: number | string | null;
    /** The row's name when its title alone does not say it (the service an account belongs to, its state). */
    accessibilityLabel?: string;
    /** The row's own menu, at its end, outside the row's press (a project's rename, pin, remove). */
    rightElement?: React.ReactNode;
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const onPlane = props.surface !== 'page';
    const rowRole = props.rowRole ?? 'item';
    // A disclosure's count speaks for rows it hides: while it is open its rows are listed and the count says
    // nothing more, so the end column keeps only what the row adds ("+", a state) (owner 11-01).
    const hasCount = props.count !== undefined && props.count !== null && props.count !== ''
        && !(props.disclosure && props.disclosure.expanded);
    const count = hasCount ? <Text style={styles.trailingCount}>{String(props.count)}</Text> : null;
    const trailing = props.status && hasCount ? (
        <View style={styles.trailing}>
            {props.status}
            <Text style={styles.trailingCount}>{String(props.count)}</Text>
        </View>
    ) : props.status ?? count;
    const onToggle = props.disclosure?.onToggle;
    const disclosureTarget = props.disclosure && onToggle ? (
        <HappierTreeDisclosure
            testID={`${props.testID}:disclosure`}
            kind="branch"
            expanded={props.disclosure.expanded}
            color={theme.colors.text.tertiary}
            activeColor={theme.colors.text.secondary}
            reducedMotion={reducedMotion}
            accessibilityLabel={props.disclosure.expanded ? t('common.collapse') : t('common.expand')}
            onPress={onToggle}
        />
    ) : null;
    const endParts = [trailing, disclosureTarget, props.rightElement].filter(part => part != null && part !== false);
    const rightElement = endParts.length > 1
        ? <View style={styles.trailing}>{trailing}{disclosureTarget}{props.rightElement}</View>
        : endParts[0] ?? null;
    // A disclosure tree (owner 10-31): the parent's mark stands at rest; hovering or focusing the row shows its
    // disclosure in the mark's own box, so no caret column is spent. Touch keeps the mark; a tap toggles.
    const [focused, setFocused] = React.useState(false);
    const disclosureGlyph = props.disclosure && !onToggle ? (
        <View style={styles.treeMark}>
            <HappierDisclosureChevron
                expanded={props.disclosure.expanded}
                color={theme.colors.text.secondary}
                reducedMotion={reducedMotion}
            />
        </View>
    ) : null;
    // A tree's identity mark (a service, its accounts) stands on the glyph box's leading edge, so its ink starts
    // on the column's text edge under the group label instead of floating inside the box (owner 11-01).
    const treeMark = props.disclosure !== undefined ? <View style={[styles.treeMark, styles.treeMarkLeading]}>{props.icon}</View> : null;
    const childMark = !treeMark && props.child && props.icon ? <View style={[styles.treeMark, styles.treeMarkLeading]}>{props.icon}</View> : null;
    const treeLead = treeMark ? {
        leftElement: focused && disclosureGlyph ? disclosureGlyph : treeMark,
        leftElementWhenHovered: disclosureGlyph ?? undefined,
    } : null;
    const treeFocus = treeLead ? {
        onFocus: () => { setFocused(true); props.treeItem?.onFocus?.(); },
        onBlur: () => { setFocused(false); props.treeItem?.onBlur?.(); },
    } : null;
    const indentPx = (props.indentPx ?? 0) + (props.child ? resolveHappierCollectionTreeChildIndentPx() : 0);
    const row = (
        <Item
            testID={props.testID}
            rightElement={rightElement}
            rightElementOutsidePressable={Boolean(props.rightElement || disclosureTarget)}
            title={props.title}
            rowRole={rowRole}
            titleLines={1}
            subtitle={props.subtitle}
            subtitleLeading={props.subtitleLeading}
            titleAccessory={props.titleAccessory}
            titleQualifier={props.titleQualifier}
            accessibilityExpanded={props.disclosure ? props.disclosure.expanded : undefined}
            {...props.treeItem}
            {...treeFocus}
            subtitleStyle={props.subtitleMono ? styles.monoSubtitle : undefined}
            {...(treeLead
                ? treeLead
                : props.leftElement
                ? { leftElement: props.leftElement, leftElementWhenHovered: props.leftElementWhenHovered }
                : { icon: childMark ?? props.icon })}
            // A described row's mark and end state belong to its title: they sit level with the title's line
            // rather than between the title and the line under it (owner 11-01).
            contentAlign={props.subtitle ? 'start' : undefined}
            accessibilityLabel={props.subtitle ? [props.accessibilityLabel ?? props.title, props.subtitle].join('. ') : props.accessibilityLabel}
            detail={props.status || hasCount ? undefined : props.detail}
            density="compact"
            selected={props.selected}
            showChevron={false}
            pressableStyle={props.selected && onPlane ? [HAPPIER_COLLECTION_LIST_ROW_STYLE, styles.navigationRowSelected] : HAPPIER_COLLECTION_LIST_ROW_STYLE}
            titleStyle={props.selected && onPlane ? styles.navigationRowTitleSelected : undefined}
            dimmed={props.dimmed === true && !(props.selected && onPlane)}
            style={resolveHappierCollectionListRowPadding(indentPx)}
            showDivider={false}
            onPress={props.onPress}
        />
    );
    return props.href ? <WorkspaceDestinationRow href={props.href}>{actions => React.cloneElement(row, { onLongPress: actions.openMenu })}</WorkspaceDestinationRow> : row;
});

/** Host styles for rows inside a collection list. */
export const collectionListStyles: Readonly<{
    row: typeof HAPPIER_COLLECTION_LIST_ROW_STYLE;
    rowSelectedOnPlane: typeof styles.navigationRowSelected;
    rowTitleSelectedOnPlane: typeof styles.navigationRowTitleSelected;
    dimmedTitle: typeof styles.dimmedTitle;
    troubleDot: typeof styles.troubleDot;
    stateLine: typeof styles.stateLine;
}> = {
    /** A row's pressable: inset from the list's edges, with a soft rounded selection. */
    row: HAPPIER_COLLECTION_LIST_ROW_STYLE,
    /** The plane's selected chip and title weight, for a row richer than `CollectionNavigationRow` on a column. */
    rowSelectedOnPlane: styles.navigationRowSelected,
    rowTitleSelectedOnPlane: styles.navigationRowTitleSelected,
    dimmedTitle: styles.dimmedTitle,
    /** Only trouble gets a dot (needs sign-in, not running, failed). */
    troubleDot: styles.troubleDot,
    /** Wraps a `SurfaceStateCard size="line"` so it sits on the rows' text edge. */
    stateLine: styles.stateLine,
} as const;

/** A navigation column's row geometry for the shared loading rows: the rows' text edge and glyph column. */
const COLLECTION_LIST_SKELETON_GEOMETRY = Object.freeze({
    insetStart: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    insetEnd: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    glyphColumn: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
    gap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
});

/**
 * A list's first load: the shared loading rows in the column's one-line navigation rows (the compact
 * row height, the glyph column), so the real rows replace them without a jump. Shown only while nothing
 * is known yet; known rows stay while they refresh.
 */
export function CollectionSkeletonRows(props: Readonly<{ count: number; rowRole?: HappierCollectionRowRole }>) {
    const described = props.rowRole === 'catalogRow';
    // In a column a described row keeps the column's glyph column; only a page's catalog row has the catalog box.
    const pageCatalog = described && !useHappierCollectionListRow();
    return (
        <SkeletonRows
            rows={props.count}
            rowHeight={pageCatalog ? HAPPIER_COLLECTION_LIST_METRICS.catalogRow.minHeight
                : described ? HAPPIER_COLLECTION_LIST_METRICS.describedRowMinHeight : HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight}
            lines={described ? 2 : 1}
            geometry={pageCatalog ? { ...COLLECTION_LIST_SKELETON_GEOMETRY,
                glyphColumn: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markBox,
                gap: HAPPIER_COLLECTION_LIST_METRICS.catalogRow.markGap,
            } : COLLECTION_LIST_SKELETON_GEOMETRY}
        />
    );
}

function keepDraftOpen() {}

/**
 * The item being added, at the top of the list and selected while its editor is open in the detail.
 * It shows the name as it is typed, or the placeholder until then.
 */
export const CollectionDraftRow = React.memo(function CollectionDraftRow(props: Readonly<{
    testID?: string;
    titles: HappierCollectionDraftTitleStore;
    placeholder: string;
    /** The kind's mark; a disclosed child (an account being added under its service) has none. */
    mark?: React.ReactNode;
    /** Drawn as a disclosed child of its group's parent row, on the parent's title edge. */
    child?: boolean;
    rowRole?: HappierCollectionRowRole;
}>) {
    const draft = useHappierCollectionDraftRowTitle(props.titles, props.placeholder);
    return (
        <Item
            rowRole={props.rowRole ?? 'item'}
            testID={props.testID}
            title={draft.title}
            titleStyle={draft.untitled ? styles.dimmedTitle : undefined}
            // Says what the row is: an item being added that is not saved yet.
            subtitle={t('common.draft')}
            icon={props.mark}
            selected
            density="compact"
            showChevron={false}
            pressableStyle={HAPPIER_COLLECTION_LIST_ROW_STYLE}
            style={props.child
                ? resolveHappierCollectionListRowPadding(resolveHappierCollectionTreeChildIndentPx())
                : undefined}
            // The draft is already the open detail; a press has nothing left to open, but the row stays a
            // row (Item draws the selection only on pressable rows).
            onPress={keepDraftOpen}
        />
    );
});
