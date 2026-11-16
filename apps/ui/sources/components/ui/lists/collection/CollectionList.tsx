import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
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
    type HappierCollectionListTextRole,
    type HappierCollectionListProps,
    type HappierCollectionRowRole,
    HAPPIER_ICON_BUTTON_SIZE,
    HAPPIER_FOCUS_RING_DELEGATED_STYLE,
    happierFocusRingStyle,
    resolveHappierFocusRingVisible,
    useHappierMaterialColorResolver,
    HappierListRowFollowedContext,
    HappierListRowPrecedesSelectedContext,
} from '@happier-dev/plugin-ui/presentation';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { flattenItemGroupElementChildren } from '@/components/ui/lists/ItemGroup.dividers';
import { useHeaderControlMetrics, type HeaderControlMetrics } from '@/components/ui/icons/iconButtonGlyphSize';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { CollectionRowNeedsYouLeading } from './CollectionRowNeedsYouHighlight';
import { CollectionRowMenuEngagementContext, ROW_MENU_BUTTON_PX } from './CollectionRowMenu';
import { useCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';

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

import { PhonePageBackLine, usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
// Used at render time only: the main-screen head draws this list's own magnifier and "+" from this module.
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { useDeviceType } from '@/utils/platform/responsive';
import { useNavigationLeavesLargeTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useTouchCompactRow } from '@/components/ui/lists/collection/CollectionRowContent';

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
    // On a phone the list is the screen: its group labels are section labels, in the text tone.
    groupTitleTouch: {
        ...listText('groupTitleTouch'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    subgroupTitleTouch: {
        ...listText('subgroupTitleTouch'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
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
    // The row's end column: the status slot, then the quiet count, on one right edge. It shrinks inside the row's
    // end cap so a long state word truncates there; the count and the disclosure keep their width.
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
        minWidth: 0,
    },
    // A column row's ⋯ stands over the end of its status and count (or of the title, when the row has none).
    rowMenuEnd: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'stretch',
        flexShrink: 1,
        minWidth: 0,
    },
    rowMenuBand: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    restingEnd: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    restingEndHidden: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        opacity: 0,
    },
    trailingCount: {
        flexShrink: 0,
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
    // The chip is ~1.06:1 against the plane, below WCAG 1.4.11's 3:1, so the title's weight carries
    // the state as well.
    navigationRowTitleSelected: {
        ...listText('rowTitleSelected'),
    },
}));

// The host's text roles name their styles; each Text reads `styles` while it renders, so Unistyles keeps it bound to
// the current theme (a style object captured at module scope keeps the theme it was first read under on native).
const textRoleStyleKeys = {
    title: 'title',
    count: 'count',
    subtitle: 'subtitle',
    groupTitle: 'groupTitle',
    subgroupTitle: 'groupTitle',
    groupHeading: 'groupHeading',
    groupCount: 'groupCount',
} as const satisfies Readonly<Record<HappierCollectionListTextRole, keyof typeof styles>>;

type CollectionListTextStyleKey = (typeof textRoleStyleKeys)[HappierCollectionListTextRole] | 'groupTitleTouch' | 'subgroupTitleTouch';

function createCollectionListText(roleStyleKeys: Readonly<Record<HappierCollectionListTextRole, CollectionListTextStyleKey>>): HappierCollectionListHost['Text'] {
    return (props) => (
        <Text
            style={styles[roleStyleKeys[props.role]]}
            {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
            {...(props.accessibilityRole === undefined ? {} : { accessibilityRole: props.accessibilityRole })}
            {...(props.testID === undefined ? {} : { testID: props.testID })}
        >
            {props.children}
        </Text>
    );
}

const collectionListHost: HappierCollectionListHost = {
    Text: createCollectionListText(textRoleStyleKeys),
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
    SearchToggle: (props) => <CollectionSearchToggle {...props} />,
    surfaceStyle: styles.surface,
    // Read while rendering: a runtime light/dark switch repaints a mounted list's ground (header and rows alike).
    useSurfaceStyle: useCollectionListSurfaceStyle,
    useGroupGlyphColor: useCollectionListGroupGlyphColor,
};

/** A column's search toggle under a precise pointer: the IconButton's own size with the header's `sm` glyph. */
const COLLECTION_SEARCH_TOGGLE_CONTROL: HeaderControlMetrics = Object.freeze({ sizePx: HAPPIER_ICON_BUTTON_SIZE, glyphPx: ICON_SIZE.sm });

/**
 * The title row's magnifier: a collection's own, and a main screen that is a page rather than a list (People,
 * Settings) draws the same one beside its title.
 */
export function CollectionSearchToggle(props: React.ComponentProps<NonNullable<HappierCollectionListHost['SearchToggle']>> & Readonly<{
    /** Receives the toggle, so closing the field can hand focus back to it. */
    controlRef?: React.ComponentProps<typeof IconButton>['controlRef'];
}>) {
    const control = useHeaderControlMetrics(COLLECTION_SEARCH_TOGGLE_CONTROL);
    return (
        <IconButton
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            {...(props.controlRef === undefined ? {} : { controlRef: props.controlRef })}
            accessibilityLabel={props.accessibilityLabel}
            tooltip={props.accessibilityLabel}
            variant="plain"
            size={control.sizePx}
            iconSize={control.glyphPx}
            selected={props.open}
            iconName="magnifying-glass"
            onPress={props.onPress}
        />
    );
}

/** The list's own ground in the current theme. */
function useCollectionListSurfaceStyle() {
    const base = useUnistyles().theme.colors.surface.base;
    return React.useMemo(() => ({ backgroundColor: glassSurfaceBackgroundColor(base, 'content', true) }), [base]);
}

/**
 * A navigation column beside the page (the app shell's column) lies on the column's plane
 * (`appShellColumnSurface`): the list draws no ground of its own there, in every theme.
 */
const PLANE_SURFACE = Object.freeze({ backgroundColor: 'transparent' });
function useCollectionListPlaneSurfaceStyle() {
    // The same hooks as the page ground's (`useCollectionListSurfaceStyle`): a list that turns from a column into the page
    // in place (Workflows' column becoming the phone page) swaps hosts without changing its hook order.
    useUnistyles();
    return React.useMemo(() => PLANE_SURFACE, []);
}

/** A group label's own glyphs (its disclosure chevron): the quiet tertiary ink of its count. */
function useCollectionListGroupGlyphColor(): string {
    return useUnistyles().theme.colors.text.tertiary;
}

const collectionListPlaneHost: HappierCollectionListHost = {
    ...collectionListHost, surfaceStyle: PLANE_SURFACE, useSurfaceStyle: useCollectionListPlaneSurfaceStyle,
};

/** A list on a phone: its group labels read as section labels (`groupTitleTouch`). */
const collectionListTouchHost: HappierCollectionListHost = {
    ...collectionListHost,
    Text: createCollectionListText({ ...textRoleStyleKeys, groupTitle: 'groupTitleTouch', subgroupTitle: 'subgroupTitleTouch' }),
};

const collectionListPhonePageHost: HappierCollectionListHost = {
    ...collectionListHost,
    Text: (props) => props.role === 'title' ? (
        <Text style={styles.pageTitle} accessibilityRole="header" {...(props.testID === undefined ? {} : { testID: props.testID })}>{props.children}</Text>
    ) : <collectionListHost.Text {...props} />,
};

/**
 * Set by the app shell's column (`AppShellColumn`), the one owner of "this list is the navigation column beside the
 * page": a list inside it lies on the shell's plane and paints no ground of its own, whichever destination draws it
 * (owner 2026-11-15, A4: sidebar backgrounds are gone app-wide). A list that names its `surface` keeps it.
 */
export const CollectionShellColumnSurfaceContext = React.createContext<'plane' | undefined>(undefined);

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
    /**
     * The list is the whole phone page (a main screen: Boards, Discussions). Its head line stands under the status
     * bar, empty on a main screen and carrying the Back on a page it pushes (`usePhoneDestinationBack`).
     */
    phonePage?: Readonly<{
        backTestID: string;
        /**
         * The kind's mark each row leads with on the phone page when the row has none of its own (owner 11-11); the rows
         * keep the one content-row anatomy, flat on the page (owner 2026-11-15).
         */
        rowMark?: IconName;
    }> | null;
    /**
     * The list's create action: the header "+" (unless `headerAction` names another), and on a phone main screen the
     * bar's "+" beside the tabs (`usePublishPageCreateAction`), so both run the same thing.
     */
    create?: PageCreateAction | null;
}>) {
    const { surface: ownSurface, toolsInsetPx, phonePage, create, headerAction, children, ...listRest } = props;
    const shellColumnSurface = React.useContext(CollectionShellColumnSurfaceContext);
    const surface = ownSurface ?? shellColumnSurface;
    // The column states its own rows' order, so each draws the one list-row rule (owner 2026-11-15).
    const listProps = { ...listRest, children: orderCollectionColumnRows(children) };
    const largeTitle = useNavigationLeavesLargeTitle();
    const pageToolsInsetPx = React.useContext(CollectionPageToolsInsetContext);
    const resolvedToolsInsetPx = toolsInsetPx ?? pageToolsInsetPx;
    const createAction = headerAction ?? (create ? <CollectionCreateButton create={create} /> : undefined);
    const phone = useDeviceType() === 'phone';
    const rowMark = phone ? phonePage?.rowMark ?? null : null;
    const pageRows = React.useMemo(() => rowMark ? { mark: rowMark } : null, [rowMark]);
    if (phonePage && phone) {
        // A phone page heads with the one main-screen head (F2): the Home line on a main screen, the title (or its
        // scope control), the magnifier and "+" on its row, what the title scopes right under it. The list keeps
        // only its rows, filters and footer.
        const { title, titleControl, count: _count, subtitle, strip, titleAccessory, search, ...bodyProps } = listProps;
        return (
            <CollectionPhonePageRowsContext.Provider value={pageRows}>
                <CollectionPhonePageBack backTestID={phonePage.backTestID} />
                <MainScreenHeader
                    title={title ?? ''}
                    {...(titleControl == null ? {} : { titleControl })}
                    {...(subtitle ? { description: subtitle.text } : {})}
                    search={search ? {
                        value: search.value,
                        onChangeText: search.onChangeText,
                        placeholder: search.placeholder,
                        testID: search.testID ?? `${listProps.testID ?? 'collection'}:search`,
                        ...(search.trailing == null ? {} : { trailing: search.trailing }),
                    } : null}
                    create={create ?? null}
                    {...(headerAction === undefined ? {} : { createTrigger: headerAction })}
                    {...(strip != null || titleAccessory != null ? { band: <>{strip}{titleAccessory}</> } : {})}
                />
                <HappierCollectionList
                    host={collectionListPhonePageHost}
                    {...(resolvedToolsInsetPx === undefined ? {} : { toolsInsetPx: resolvedToolsInsetPx })}
                    {...bodyProps}
                />
            </CollectionPhonePageRowsContext.Provider>
        );
    }
    return (
        <CollectionPhonePageRowsContext.Provider value={pageRows}>
            {phonePage ? <CollectionPhonePageBack backTestID={phonePage.backTestID} /> : null}
            <HappierCollectionList
                host={surface === 'plane' ? collectionListPlaneHost : phonePage || largeTitle ? collectionListPhonePageHost : collectionListHost}
                {...(resolvedToolsInsetPx === undefined ? {} : { toolsInsetPx: resolvedToolsInsetPx })}
                {...(createAction === undefined ? {} : { headerAction: createAction })}
                {...listProps}
            />
        </CollectionPhonePageRowsContext.Provider>
    );
});

/** Set while the list is a phone main screen's whole body: its rows draw the page row anatomy with this mark. */
const CollectionPhonePageRowsContext = React.createContext<Readonly<{ mark: IconName }> | null>(null);

/** Whether this list owns the phone page's card anatomy, decided by CollectionList. */
export function useCollectionPhonePageRows(): boolean {
    return React.useContext(CollectionPhonePageRowsContext) !== null;
}

/**
 * A run of a list's rows, flat on the plane or the phone page (owner 2026-11-15: no card per list): it states their
 * order, so each row draws the one list-row rule under it while another row follows, and none beside the selected one.
 */
export function CollectionRows(props: Readonly<{ children: React.ReactNode }>) {
    const rows = flattenItemGroupElementChildren(props.children);
    return (
        <>
            {rows.map((row, index) => {
                const next = rows[index + 1];
                return (
                    <CollectionRowOrder key={row.key ?? index} followed={next !== undefined}
                        precedesSelected={(next?.props as { selected?: unknown } | undefined)?.selected === true}>
                        {row}
                    </CollectionRowOrder>
                );
            })}
        </>
    );
}

/**
 * A column's own rows, written as its direct children between its group labels: each consecutive run of
 * `CollectionNavigationRow`s is ordered as `CollectionRows` orders its rows. A component that wraps its rows states
 * their order itself (`CollectionRows`, `CollectionRowOrder`).
 */
function orderCollectionColumnRows(children: React.ReactNode): React.ReactNode {
    const nodes = flattenItemGroupElementChildren(children);
    if (!nodes.some(node => node.type === CollectionNavigationRow)) return children;
    return nodes.map((node, index) => {
        if (node.type !== CollectionNavigationRow) return node;
        const next = nodes[index + 1];
        const nextRow = next?.type === CollectionNavigationRow ? next : undefined;
        return (
            <CollectionRowOrder key={node.key ?? index} followed={nextRow !== undefined}
                precedesSelected={(nextRow?.props as { selected?: unknown } | undefined)?.selected === true}>
                {node}
            </CollectionRowOrder>
        );
    });
}

/**
 * A row's place in its list, for a list that renders its rows itself (a virtualized column): whether another row of
 * its section follows, and whether that row is the selected one. Rows read it to draw the one list-row rule.
 */
export function CollectionRowOrder(props: Readonly<{ followed: boolean; precedesSelected: boolean; children: React.ReactNode }>) {
    return (
        <HappierListRowFollowedContext.Provider value={props.followed}>
            <HappierListRowPrecedesSelectedContext.Provider value={props.precedesSelected}>
                {props.children}
            </HappierListRowPrecedesSelectedContext.Provider>
        </HappierListRowFollowedContext.Provider>
    );
}

/** A whole phone page's line under the status bar: its Back on a pushed page; the main-screen head lends the bar its "+". */
function CollectionPhonePageBack(props: Readonly<{ backTestID: string }>) {
    const back = usePhoneDestinationBack(props.backTestID);
    return <PhonePageBackLine control={back} page />;
}

/** The header "+": the list's create action, drawn like the column's search toggle beside it. */
/** A page that is not a list draws the same "+" on its title row (People). */
export function CollectionCreateButton(props: Readonly<{ create: PageCreateAction }>) {
    const control = useHeaderControlMetrics(COLLECTION_SEARCH_TOGGLE_CONTROL);
    return (
        <IconButton
            testID={`${props.create.testID}:header`}
            accessibilityLabel={props.create.label}
            tooltip={props.create.label}
            variant="plain"
            size={control.sizePx}
            iconSize={control.glyphPx}
            iconName="plus"
            onPress={props.create.onPress}
        />
    );
}

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
    // The touch-compact decision is the one the list's rows take, so labels and rows recompose together.
    const touch = useTouchCompactRow(true);
    return <HappierCollectionListGroupLabel host={touch ? collectionListTouchHost : collectionListHost} {...props} />;
}

/**
 * One navigation row in a column (Settings, Plugins, a Home console, settings search results): core's
 * binding of the list anatomy's row — the same gutter, content inset, chip and heavier open title a
 * plugin's `NavigationList.Row` draws through `HappierListItem`. `leftElement` replaces the icon where
 * the row discloses children.
 */
export type CollectionNavigationRowProps = Readonly<{
    /** A navigable destination: workspace menu, pointer and drag intent share the workspace owner. */
    href?: string | null;
    testID: string;
    title: string;
    subtitle?: string;
    /** Navigation keeps its compact role even when it has a descriptive subtitle. */
    rowRole?: Exclude<HappierCollectionRowRole, 'catalogRow'>;
    /** An inline mark before the subtitle: the collection's trouble dot when the row needs the person. */
    subtitleLeading?: React.ReactNode;
    /** Trouble already decided by the work owner: the shared mark and opt-in needs-you treatment. */
    needsYouStatus?: WorkStatusPresentation | null;
    /**
     * The row needs the person and says why itself (its state in its `status` slot, an Environment's): the shared
     * needs-you row treatment alone, without the work-status mark `needsYouStatus` adds.
     */
    needsYou?: boolean;
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
    /**
     * A mark that tells this row from its neighbours: one the person or a plugin set, a built-in's own, an Agent or
     * Provider, a per-row state. A kind glyph every row of the list would repeat is left out (LIST-ICONS-1108):
     * without a mark the row keeps no glyph column and its title starts on the list's text edge.
     */
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
    /** Unread news retains its emphasis when the column becomes a phone page. */
    unread?: boolean;
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
    /** A control at the row's end, outside the row's press, always in its place. */
    rightElement?: React.ReactNode;
    /**
     * The row's own ⋯ (`CollectionRowMenu`: a project's rename, pin, remove). On a pointer screen it takes no width at
     * rest, so the name runs to the row's end; while the row is engaged it stands over the row's end in place of its
     * status and count, the title's tail fading under it (the Session rows' engaged actions). Touch keeps it in place.
     */
    rowMenu?: React.ReactNode;
    /** An independently actionable request stays outside row navigation. */
    rightElementOutsidePressable?: boolean;
    onPress: () => void;
}>;

export const CollectionNavigationRow = React.memo(function CollectionNavigationRow(props: CollectionNavigationRowProps) {
    const pageRows = React.useContext(CollectionPhonePageRowsContext);
    const { theme } = useUnistyles();
    // A phone main screen's body draws the same row as the column (owner 2026-11-15: one content-row anatomy on every
    // phone collection), led by the kind's mark when the row has none of its own.
    const icon = pageRows && !props.icon ? <Icon name={pageRows.mark} size={ICON_SIZE.md} color={theme.colors.text.secondary} /> : props.icon;
    return <CollectionColumnRow {...props} icon={icon} />;
});

const CollectionColumnRow = React.memo(function CollectionColumnRow(props: CollectionNavigationRowProps) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const onPlane = props.surface !== 'page';
    const selectedFill = useCollectionRowSelectedOnPlaneFill();
    const rowRole = props.rowRole ?? 'item';
    const needsYou = Boolean(props.needsYouStatus) || props.needsYou === true;
    const needsYouFacts = React.useMemo(() => needsYou
        ? { unopened: !props.selected, visible: true } : null, [needsYou, props.selected]);
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
    const coarsePointer = useCoarsePrimaryPointer();
    const overlaysMenu = props.rowMenu != null && Platform.OS === 'web' && !coarsePointer;
    const [pressHovered, setPressHovered] = React.useState(false);
    const [endHovered, setEndHovered] = React.useState(false);
    const [menuHeld, setMenuHeld] = React.useState(false);
    const engaged = overlaysMenu && (pressHovered || endHovered || menuHeld);
    const engagement = React.useMemo(() => ({ engaged, hold: setMenuHeld }), [engaged]);
    const inFlowMenu = overlaysMenu ? null : props.rowMenu;
    const endParts = [trailing, disclosureTarget, props.rightElement, inFlowMenu].filter(part => part != null && part !== false);
    const rightElement = overlaysMenu ? (
        <View style={styles.trailing} onPointerEnter={() => setEndHovered(true)} onPointerLeave={() => setEndHovered(false)}>
            {/* The status and count give their place to the ⋯ while the row is engaged; the disclosure keeps its own. */}
            <View style={styles.rowMenuEnd}>
                {trailing ? (
                    <View style={engaged ? styles.restingEndHidden : styles.restingEnd}
                        {...(engaged ? { 'aria-hidden': true } : {})}>{trailing}</View>
                ) : null}
                <View style={styles.rowMenuBand}>
                    <CollectionRowMenuEngagementContext.Provider value={engagement}>{props.rowMenu}</CollectionRowMenuEngagementContext.Provider>
                </View>
            </View>
            {disclosureTarget}
            {props.rightElement}
        </View>
    ) : endParts.length > 1
        ? <View style={styles.trailing}>{trailing}{disclosureTarget}{props.rightElement}{inFlowMenu}</View>
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
    // On the web a tree row is one treeitem holding everything the row draws, its own controls included (its
    // disclosure, its menu, its status), so the tree owns only treeitems (axe aria-required-children). The
    // treeitem takes the roving tab stop, the keys and the tree state; the press target inside leaves the tab
    // order and draws the focus ring the treeitem delegates to it.
    const webTreeItem = Platform.OS === 'web' ? props.treeItem ?? null : null;
    const [treeRingVisible, setTreeRingVisible] = React.useState(false);
    const accessibilityLabel = props.subtitle ? [props.accessibilityLabel ?? props.title, props.subtitle].join('. ') : props.accessibilityLabel;
    const basePressableStyle = props.selected && onPlane ? [HAPPIER_COLLECTION_LIST_ROW_STYLE, selectedFill] : HAPPIER_COLLECTION_LIST_ROW_STYLE;
    const treeRing = webTreeItem && treeRingVisible ? happierFocusRingStyle({ visible: true, color: theme.colors.border.focus, placement: 'inset' }) : null;
    const row = (
        <Item
            testID={props.testID}
            underlay={needsYouFacts ? <CollectionRowNeedsYouLeading {...needsYouFacts} testID={`${props.testID}:needs-you`} /> : undefined}
            rightElement={rightElement}
            rightElementOutsidePressable={Boolean(props.rightElement || props.rowMenu || disclosureTarget)}
            {...(overlaysMenu ? {
                onHoverIn: () => setPressHovered(true),
                onHoverOut: () => setPressHovered(false),
                ...(engaged ? { pressTargetEndFadePx: ROW_MENU_BUTTON_PX } : {}),
            } : null)}
            // Inside the press only the status slot and the count remain, and they only draw.
            rightElementPassive
            title={props.title}
            rowRole={rowRole}
            titleLines={1}
            subtitle={props.subtitle}
            subtitleLeading={props.needsYouStatus ? <WorkStatusRowMark status={props.needsYouStatus}
                testIDSuffix={props.testID} needsYouHighlight={needsYouFacts} /> : props.subtitleLeading}
            titleAccessory={props.titleAccessory}
            titleQualifier={props.titleQualifier}
            accessibilityExpanded={props.disclosure ? props.disclosure.expanded : undefined}
            {...(webTreeItem ? WEB_TREE_ROW_PRESS_PROPS : props.treeItem)}
            {...(webTreeItem ? null : treeFocus)}
            subtitleStyle={props.subtitleMono ? styles.monoSubtitle : undefined}
            {...(treeLead
                ? treeLead
                : props.leftElement
                ? { leftElement: props.leftElement, leftElementWhenHovered: props.leftElementWhenHovered }
                : { icon: childMark ?? props.icon })}
            // A described row's mark and end state belong to its title: they sit level with the title's line
            // rather than between the title and the line under it (owner 11-01).
            contentAlign={props.subtitle ? 'start' : undefined}
            accessibilityLabel={accessibilityLabel}
            detail={props.status || hasCount ? undefined : props.detail}
            density="compact"
            selected={props.selected}
            showChevron={false}
            pressableStyle={treeRing ? [basePressableStyle, treeRing] : basePressableStyle}
            titleStyle={props.selected && onPlane || props.unread ? styles.navigationRowTitleSelected : undefined}
            dimmed={props.dimmed === true && !(props.selected && onPlane)}
            style={resolveHappierCollectionListRowPadding(indentPx)}
            showDivider={false}
            onPress={props.onPress}
        />
    );
    const rowNode = props.href ? <WorkspaceDestinationRow href={props.href}>{actions => React.cloneElement(row, { onLongPress: actions.openMenu })}</WorkspaceDestinationRow> : row;
    if (!webTreeItem) return rowNode;
    // The treeitem's own focus, not focus moving onto a control inside it (its disclosure, its menu).
    const ownFocus = (event?: { target?: unknown; currentTarget?: unknown }) => !event || event.target === event.currentTarget;
    const treeItemProps = {
        role: 'treeitem' as const,
        tabIndex: webTreeItem.webTabIndex ?? 0,
        'aria-level': webTreeItem.accessibilityLevel,
        'aria-posinset': webTreeItem.accessibilityPositionInSet,
        'aria-setsize': webTreeItem.accessibilitySetSize,
        'aria-expanded': webTreeItem.accessibilityExpanded ?? (props.disclosure ? props.disclosure.expanded : undefined),
        'aria-selected': props.selected,
        'aria-label': accessibilityLabel ?? props.title,
        onKeyDown: webTreeItem.onKeyDown,
        onFocus: (event?: { target?: unknown; currentTarget?: unknown }) => {
            if (!ownFocus(event)) return;
            setFocused(true);
            setTreeRingVisible(resolveHappierFocusRingVisible(true));
            webTreeItem.onFocus?.();
        },
        onBlur: (event?: { target?: unknown; currentTarget?: unknown }) => {
            if (!ownFocus(event)) return;
            setFocused(false);
            setTreeRingVisible(false);
            webTreeItem.onBlur?.();
        },
    };
    return (
        <View ref={webTreeItem.pressableRef as unknown as React.Ref<View>} testID={`${props.testID}:treeitem`}
            style={HAPPIER_FOCUS_RING_DELEGATED_STYLE as StyleProp<ViewStyle>} {...(treeItemProps as object)}>
            {rowNode}
        </View>
    );
});

/** A web tree row's press target: inside its treeitem, out of the tab order (the treeitem holds the roving stop). */
const WEB_TREE_ROW_PRESS_PROPS = Object.freeze({ webTabIndex: -1 as const });

/**
 * The plane's selected chip: `Item`'s own `surface.selected` is the plane's colour, so an open navigation row lifts to
 * the elevated surface (the plugin realm's `navigationSelected`), resolved through the containing material: over glass
 * it is the plane's tint, never an opaque chip (owner 2026-11-11, desktop #13). The one owner for every column row; it
 * is a plain resolved style because `Item` cannot read a Unistyles stylesheet colour to resolve it itself.
 */
export function useCollectionRowSelectedOnPlaneFill(): Readonly<{ backgroundColor: string }> {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const elevated = theme.colors.surface.elevated;
    return React.useMemo(() => ({ backgroundColor: paintColor(elevated) }), [paintColor, elevated]);
}

/** Host styles for rows inside a collection list. */
export const collectionListStyles: Readonly<{
    row: typeof HAPPIER_COLLECTION_LIST_ROW_STYLE;
    rowTitleSelectedOnPlane: typeof styles.navigationRowTitleSelected;
    dimmedTitle: typeof styles.dimmedTitle;
    troubleDot: typeof styles.troubleDot;
    stateLine: typeof styles.stateLine;
}> = {
    /** A row's pressable: inset from the list's edges, with a soft rounded selection. */
    row: HAPPIER_COLLECTION_LIST_ROW_STYLE,
    /** The plane's selected title weight, for a row richer than `CollectionNavigationRow` on a column. Its chip is `useCollectionRowSelectedOnPlaneFill`. */
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
