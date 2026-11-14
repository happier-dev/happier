import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    resolveHappierCollectionTreeChildIndentPx,
    useHappierTreeInteraction,
    type HappierTreeNode,
} from '@happier-dev/plugin-ui/presentation';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { CollectionListGroupLabel, CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import {
    ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX,
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    applyProjectsTreeCheckoutFacts,
    buildProjectsTreeRows,
    projectsTreeCheckoutKey,
    projectsTreeGlyphIcon,
    projectsTreeRowEnvironment,
    projectsTreeRowOpenTarget,
    projectsTreeRowSubtitle,
    type ProjectsTreeProject,
    type ProjectsTreeRow,
} from './projectsTreeRows';
import { useProjectsTreeCheckoutFactsFor, type ProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

/**
 * The Projects tree's keyboard and semantics through the shared tree owner (`useHappierTreeInteraction`):
 * treeitem levels and expanded state, one roving tab stop, arrows/Home/End move, Right/Left/Space
 * disclose, Enter activates (a row opens what its press opens; a machine row toggles). Focus repairs to the
 * nearest visible ancestor when a branch closes or a Project is hidden. The column and the phone list
 * both bind their rows through it — there is no Projects-specific keyboard engine.
 */
export function useProjectsTreeKeyboard(rows: readonly ProjectsTreeRow[], handlers: Readonly<{
    onToggle: (key: string) => void;
    onOpenRow: (row: ProjectsTreeRow) => void;
    /** A windowed list brings the row at this visible index into view, so focus can land on it once it mounts. */
    onRevealIndex?: (index: number) => void;
}>) {
    const visibleNodes = React.useMemo((): HappierTreeNode[] => {
        const ancestors: ProjectsTreeRow[] = [];
        return rows.map((row) => {
            while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= row.level) ancestors.pop();
            const node: HappierTreeNode = {
                key: row.key,
                parentKey: ancestors[ancestors.length - 1]?.key ?? null,
                depth: row.level,
                kind: row.expandable ? 'branch' : 'leaf',
                expanded: row.expanded,
            };
            if (row.expandable) ancestors.push(row);
            return node;
        });
    }, [rows]);
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const handlersRef = React.useRef(handlers);
    handlersRef.current = handlers;
    const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
    const tree = useHappierTreeInteraction({
        visibleNodes,
        focusedKey,
        onFocus: setFocusedKey,
        onExpandedChange: (key, expanded) => {
            const row = rowsRef.current.find((candidate) => candidate.key === key);
            if (row && row.expanded !== expanded) handlersRef.current.onToggle(key);
        },
        onActivate: (key) => {
            const row = rowsRef.current.find((candidate) => candidate.key === key);
            if (row) handlersRef.current.onOpenRow(row);
        },
        onRevealIndex: (index) => handlersRef.current.onRevealIndex?.(index),
    });
    const { activeKey, bindFocusTarget, onFocusChange, onKeyDown, positionOf } = tree;
    const getRowPropsForActiveKey = React.useCallback((row: ProjectsTreeRow, rowActiveKey: string | null): NonNullable<React.ComponentProps<typeof CollectionNavigationRow>['treeItem']> => {
        // Where the row stands in the whole tree: a windowed list builds only some rows, out of order.
        const position = positionOf(row.key);
        return {
            webRole: 'treeitem',
            webTabIndex: row.key === rowActiveKey ? 0 : -1,
            accessibilityLevel: row.level + 1,
            ...(position ? { accessibilityPositionInSet: position.positionInSet, accessibilitySetSize: position.setSize } : {}),
            accessibilityExpanded: row.expandable ? row.expanded : undefined,
            pressableRef: (target) => bindFocusTarget(row.key, target?.focus ? { focus: () => target.focus?.() } : null),
            onFocus: () => onFocusChange(row.key, true),
            onBlur: () => onFocusChange(row.key, false),
            onKeyDown: (event) => {
                const key = event.nativeEvent?.key ?? event.key;
                if (key && onKeyDown(row.key, key, event)) event.preventDefault?.();
            },
        };
    }, [bindFocusTarget, onFocusChange, onKeyDown, positionOf]);
    const getRowProps = React.useCallback((row: ProjectsTreeRow) => getRowPropsForActiveKey(row, activeKey), [activeKey, getRowPropsForActiveKey]);
    return { activeKey, getRowProps, getRowPropsForActiveKey, positionOf };
}

/** Opens a checkout; with an Environment, that Environment on the checkout's Project Deployments page. */
export type ProjectsTreeOpenRef = (refId: string, address?: WorkspaceAddressV1, environmentId?: string) => void;

/**
 * Where a row's press (or Enter) lands: a leaf opens its exact checkout, a Project opens on its lead checkout, an
 * Environment opens on its Project's Deployments page, and only a row with nothing to open (a machine) opens or
 * closes in place. The one press owner for the column and the phone list.
 */
export function openProjectsTreeRow(row: ProjectsTreeRow, onOpenRef: ProjectsTreeOpenRef, onToggle: (key: string) => void) {
    const target = projectsTreeRowOpenTarget(row);
    const environment = projectsTreeRowEnvironment(row);
    if (target && environment) onOpenRef(target.refId, target.workspaceAddress, environment.environmentId);
    else if (target) onOpenRef(target.refId, target.workspaceAddress);
    else if (row.expandable) onToggle(row.key);
}

export type ProjectsTreeLiveCheckoutsInput = Readonly<{
    source: ProjectsTreeCheckoutFactsSource;
    /** The Projects the structural rows were built from, without checkout facts. */
    projects: readonly ProjectsTreeProject[];
    openRefId: string | null;
    openEnvironmentId?: string | null;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys?: ReadonlySet<string>;
}>;
type ProjectsTreeLiveCheckouts = ProjectsTreeLiveCheckoutsInput & Readonly<{ projectsByKey: ReadonlyMap<string, ProjectsTreeProject> }>;

export type ProjectsTreeHiddenItem = Readonly<{ key: string; title: string; subtitle: string; refId?: string; workspaceAddress?: WorkspaceAddressV1 }>;
export type ProjectsTreeSavedItem = Readonly<{ key: string; title: string; subtitle?: string }>;

type ProjectsTreeProps = Readonly<{
    testID?: string;
    /**
     * Structural rows (membership, level, disclosure) when `live` is given; already-presented rows otherwise.
     */
    rows: readonly ProjectsTreeRow[];
    /** Live checkout facts per Project, read below the tree by each Project's own section. */
    live?: ProjectsTreeLiveCheckoutsInput | null;
    onToggle: (key: string) => void;
    onOpenRef: ProjectsTreeOpenRef;
    /** A row's own menu (New session here, Save as a source, Hide project). */
    renderRowMenu?: ((row: ProjectsTreeRow) => React.ReactNode) | null;
    hrefForRef?: ((refId: string, address?: WorkspaceAddressV1) => string | null) | null;
    saved?: Readonly<{ items: readonly ProjectsTreeSavedItem[]; onOpen: (key: string) => void }> | null;
    hidden?: Readonly<{
        items: readonly ProjectsTreeHiddenItem[];
        open: boolean;
        onToggle: () => void;
        onShow: (key: string) => void;
    }> | null;
}>;

/**
 * One drawn unit of the tree: a Project with its open machines and checkouts (its live section), a saved
 * Source, or the Hidden group's head or one of its Projects. The column windows these; a short list draws
 * them all.
 */
type ProjectsTreeItem =
    | Readonly<{ kind: 'project'; key: string; rows: readonly ProjectsTreeRow[] }>
    | Readonly<{ kind: 'savedLabel'; key: string; count: number }>
    | Readonly<{ kind: 'saved'; key: string; item: ProjectsTreeSavedItem }>
    | Readonly<{ kind: 'hiddenHead'; key: string }>
    | Readonly<{ kind: 'hidden'; key: string; item: ProjectsTreeHiddenItem }>;

const projectsTreeItemKey = (item: ProjectsTreeItem) => item.key;

/**
 * The Projects column's tree (plan 10 §2/§8, lab p-projects TREE/HIDE/HIDDEN): Projects, their
 * machines and checkouts as `buildProjectsTreeRows` folds them; parents disclose, leaves open their
 * exact checkout. Your saved Sources that are not open sit dimmed after them, and hidden Projects
 * collect in one Hidden group at the end, each with Show. `useProjectsTreeItems` is the one model both
 * renderers draw: every item inline (`ProjectsTree`), or windowed in the column (`ProjectsTreeList`).
 */
function useProjectsTreeItems(props: ProjectsTreeProps, onRevealIndex?: (index: number) => void) {
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'projects-tree';
    const { onOpenRef, onToggle } = props;
    const keyboard = useProjectsTreeKeyboard(props.rows, {
        onToggle,
        onOpenRow: (row) => openProjectsTreeRow(row, onOpenRef, onToggle),
        ...(onRevealIndex ? { onRevealIndex } : {}),
    });
    const liveInput = props.live;
    const live = React.useMemo((): ProjectsTreeLiveCheckouts | null => liveInput ? {
        ...liveInput,
        projectsByKey: new Map(liveInput.projects.map((project) => [project.key, project] as const)),
    } : null, [liveInput?.source, liveInput?.projects, liveInput?.openRefId, liveInput?.openEnvironmentId, liveInput?.expandedKeys, liveInput?.collapsedKeys]);
    const handlersRef = React.useRef({ onOpenRef, onToggle });
    handlersRef.current = { onOpenRef, onToggle };
    // These callbacks run on user intent; changing a parent's closure does not change any row's presentation.
    const openRef = React.useCallback<ProjectsTreeOpenRef>((refId, address, environmentId) => (environmentId === undefined
        ? handlersRef.current.onOpenRef(refId, address) : handlersRef.current.onOpenRef(refId, address, environmentId)), []);
    const toggle = React.useCallback((key: string) => handlersRef.current.onToggle(key), []);
    const rowListProps = React.useMemo((): ProjectsTreeRowListProps => ({
        testID,
        getRowProps: keyboard.getRowPropsForActiveKey,
        renderRowMenu: props.renderRowMenu,
        hrefForRef: props.hrefForRef,
        onOpenRef: openRef,
        onToggle: toggle,
    }), [testID, keyboard.getRowPropsForActiveKey, props.renderRowMenu, props.hrefForRef, openRef, toggle]);
    const { saved, hidden } = props;
    const items = React.useMemo((): ProjectsTreeItem[] => {
        const next: ProjectsTreeItem[] = projectRuns(props.rows).map((run) => ({ kind: 'project', key: `project:${run[0]!.key}`, rows: run }));
        if (saved && saved.items.length > 0) {
            next.push({ kind: 'savedLabel', key: 'saved', count: saved.items.length });
            for (const item of saved.items) next.push({ kind: 'saved', key: `saved:${item.key}`, item });
        }
        if (hidden && hidden.items.length > 0) {
            next.push({ kind: 'hiddenHead', key: 'hidden' });
            if (hidden.open) for (const item of hidden.items) next.push({ kind: 'hidden', key: `hidden:${item.key}`, item });
        }
        return next;
    }, [props.rows, saved, hidden]);
    // The list item each visible row lives in, so the keyboard can bring an unbuilt row into view.
    const itemIndexByRowIndex = React.useMemo(() => items.flatMap((item, index) => item.kind === 'project' ? item.rows.map(() => index) : []), [items]);
    const activeKey = keyboard.activeKey;
    const { positionOf } = keyboard;
    const renderItem = React.useCallback((item: ProjectsTreeItem): React.ReactElement | null => {
        switch (item.kind) {
            case 'project':
                return live
                    ? <ProjectsTreeLiveSection rows={item.rows} live={live} rowList={rowListProps}
                        activeKey={item.rows.some(row => row.key === activeKey) ? activeKey : null}
                        position={positionOf(item.rows[0]!.key)} />
                    : <ProjectsTreeRowList rows={item.rows} activeKey={activeKey} {...rowListProps} />;
            case 'savedLabel':
                // Drawn for the eye; each saved row says it is not open in its own name, so the tree owns only items.
                return <View aria-hidden><CollectionListGroupLabel testID={`${testID}-saved`} title={t('projects.identity.savedNotOpen')} count={item.count} /></View>;
            case 'saved':
                return (
                    <CollectionNavigationRow
                        testID={`${testID}-saved-${item.item.key}`}
                        treeItem={SECTION_TREE_ITEM}
                        accessibilityLabel={`${item.item.title}, ${t('projects.identity.notOpen')}`}
                        title={item.item.title}
                        subtitle={item.item.subtitle}
                        icon={<Icon name="folder" size={16} color={theme.colors.text.tertiary} />}
                        disclosure={null}
                        dimmed
                        selected={false}
                        rightElement={<Text style={styles.count}>{t('projects.identity.notOpen')}</Text>}
                        onPress={() => saved?.onOpen(item.item.key)}
                    />
                );
            case 'hiddenHead':
                if (!hidden) return null;
                // Hidden Projects (lab p-projects HIDE/HIDDEN): one disclosure row with the tree's trailing
                // chevron, then each hidden Project as an ordinary dimmed row with Show. The row has nothing
                // to open, so its press also discloses.
                return (
                    <View style={[styles.hidden, { borderTopColor: theme.colors.border.subtle }]}>
                        <CollectionNavigationRow
                            rowRole="item"
                            testID={`${testID}-hidden`}
                            treeItem={SECTION_TREE_ITEM}
                            title={t('projects.identity.hiddenTitle')}
                            titleQualifier={String(hidden.items.length)}
                            accessibilityLabel={t('projects.identity.hiddenCount', { count: hidden.items.length })}
                            icon={<Icon name="eye-slash" size={16} color={theme.colors.text.secondary} />}
                            disclosure={{ expanded: hidden.open, onToggle: hidden.onToggle }}
                            dimmed
                            selected={false}
                            onPress={hidden.onToggle}
                        />
                    </View>
                );
            case 'hidden':
                return (
                    <CollectionNavigationRow
                        testID={`${testID}-hidden-${item.item.key}`}
                        treeItem={HIDDEN_PROJECT_TREE_ITEM}
                        href={item.item.refId ? props.hrefForRef?.(item.item.refId, item.item.workspaceAddress) ?? null : null}
                        title={item.item.title}
                        subtitle={item.item.subtitle}
                        icon={<Icon name="folder" size={16} color={theme.colors.text.tertiary} />}
                        disclosure={null}
                        dimmed
                        selected={false}
                        rightElement={(
                            <ToolbarButton
                                testID={`${testID}-show-${item.item.key}`}
                                label={t('projects.identity.show')}
                                accessibilityLabel={`${t('projects.identity.show')} ${item.item.title}`}
                                onPress={() => hidden?.onShow(item.item.key)}
                            />
                        )}
                        // Hidden is not unreachable: the row still opens its exact checkout.
                        onPress={() => { if (item.item.refId) openRef(item.item.refId, item.item.workspaceAddress); }}
                    />
                );
        }
    }, [activeKey, hidden, live, openRef, positionOf, props.hrefForRef, rowListProps, saved, testID, theme]);
    return { testID, items, renderItem, activeKey, itemIndexByRowIndex };
}

/**
 * The tree's section rows (saved sources, the Hidden disclosure and its Projects): treeitems of their own, each its
 * own tab stop as before, so the tree owns only items; Hidden's Projects sit one level under its disclosure.
 */
const SECTION_TREE_ITEM = Object.freeze({ webRole: 'treeitem' as const, accessibilityLevel: 1 });
const HIDDEN_PROJECT_TREE_ITEM = Object.freeze({ webRole: 'treeitem' as const, accessibilityLevel: 2 });

/** The tree drawn whole: a short list (the Projects page's saved and hidden Projects). */
export const ProjectsTree = React.memo(function ProjectsTree(props: ProjectsTreeProps) {
    const tree = useProjectsTreeItems(props);
    return (
        <View testID={tree.testID} {...(Platform.OS === 'web' ? { role: 'tree' as const } : {})}>
            {tree.items.map((item) => <React.Fragment key={item.key}>{tree.renderItem(item)}</React.Fragment>)}
        </View>
    );
});

/**
 * The tree as the column's own scroller: only the Projects near the viewport are built, so opening the
 * column costs the rows in view, not one row per Project. Disclosure state stays with the column, and
 * the keyboard still walks every visible row: moving to a row not yet built scrolls it into view and
 * focus lands on it as it mounts. `header` (the column's own entries and state line) stands above the tree.
 */
export const ProjectsTreeList = React.memo(function ProjectsTreeList(props: ProjectsTreeProps & Readonly<{
    header?: React.ReactElement | null;
}>) {
    const listRef = React.useRef<VirtualizedListRef | null>(null);
    const indexRef = React.useRef<readonly number[]>([]);
    const reveal = React.useCallback((rowIndex: number) => {
        const index = indexRef.current[rowIndex];
        if (index !== undefined) void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
    }, []);
    const tree = useProjectsTreeItems(props, reveal);
    indexRef.current = tree.itemIndexByRowIndex;
    // A Project's one row before it is measured (each is measured once drawn): the row's own box, so the
    // window the list builds matches what it draws.
    const [titleLineHeight, subtitleLineHeight] = useProjectsTreeRowLineHeights();
    const estimatedItemSize = Math.max(HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight,
        titleLineHeight + subtitleLineHeight + 2 * PROJECTS_TREE_SKELETON_ROW_BOX.paddingVertical);
    const { renderItem } = tree;
    const renderListItem = React.useCallback(({ item }: Readonly<{ item: ProjectsTreeItem }>) => renderItem(item), [renderItem]);
    // The column's own entries and state lines are not tree items: they stand above the tree, not in it.
    return (
        <View style={styles.list}>
            {props.header ? <View testID={`${tree.testID}:head`}>{props.header}</View> : null}
            <View testID={tree.testID} style={styles.list} {...(Platform.OS === 'web' ? { role: 'tree' as const } : {})}>
            <VirtualizedItemList<ProjectsTreeItem>
                ref={listRef}
                presentation="grouped"
                data={tree.items}
                keyExtractor={projectsTreeItemKey}
                renderItem={renderListItem}
                extraData={tree.activeKey}
                estimatedItemSize={estimatedItemSize}
                style={styles.list}
            />
            </View>
        </View>
    );
});

type ProjectsTreeRowListProps = Readonly<{
    testID: string;
    getRowProps: ReturnType<typeof useProjectsTreeKeyboard>['getRowPropsForActiveKey'];
    renderRowMenu?: ((row: ProjectsTreeRow) => React.ReactNode) | null;
    hrefForRef?: ((refId: string, address?: WorkspaceAddressV1) => string | null) | null;
    onOpenRef: ProjectsTreeOpenRef;
    onToggle: (key: string) => void;
}>;

/**
 * The tree's rows as drawn: one shared row anatomy for every Project section. No disclosure column: every
 * mark keeps the column's text edge, a checkout steps in by one mark, and only a row with something to
 * disclose carries its chevron, at its end beside the count (owner 11-08).
 */
function ProjectsTreeRowList(props: ProjectsTreeRowListProps & Readonly<{ rows: readonly ProjectsTreeRow[]; activeKey: string | null }>) {
    const { theme } = useUnistyles();
    return (
        <>
            {props.rows.map((row) => {
                const target = projectsTreeRowOpenTarget(row);
                const status = row.attention === 'needs-you' ? (
                    <StatusDot testID={`${props.testID}-${row.key}-needs-you`} color={theme.colors.state.warning.foreground} size={6}
                        accessibilityLabel={t('projects.checkouts.needsYou')} />
                ) : row.attention === 'working' ? (
                    <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
                ) : undefined;
                return (
                    <CollectionNavigationRow
                        key={row.key}
                        testID={`${props.testID}-row-${row.key}`}
                        href={target && !row.environment ? props.hrefForRef?.(target.refId, target.workspaceAddress) ?? null : null}
                        title={row.title}
                        titleQualifier={row.titleQualifier}
                        subtitle={projectsTreeRowSubtitle(row, t('projects.identity.newFromSession')) ?? undefined}
                        icon={(
                            <Icon
                                name={projectsTreeGlyphIcon(row.glyph)}
                                size={16}
                                color={theme.colors.text.secondary}
                            />
                        )}
                        disclosure={row.expandable ? { expanded: row.expanded, onToggle: () => props.onToggle(row.key) } : null}
                        status={status}
                        needsYouStatus={row.needsYouStatus}
                        count={row.count}
                        selected={row.selected}
                        dimmed={row.offline === true}
                        indentPx={row.level * resolveHappierCollectionTreeChildIndentPx()}
                        treeItem={props.getRowProps(row, props.activeKey)}
                        accessibilityLabel={row.titleQualifier ? `${row.title}, ${row.titleQualifier}` : row.title}
                        rightElement={props.renderRowMenu?.(row) ?? null}
                        onPress={() => openProjectsTreeRow(row, props.onOpenRef, props.onToggle)}
                    />
                );
            })}
        </>
    );
}

/** The structural rows (level 0 starts a Project) grouped per Project. */
function projectRuns(rows: readonly ProjectsTreeRow[]): ProjectsTreeRow[][] {
    const runs: ProjectsTreeRow[][] = [];
    for (const row of rows) {
        if (row.level === 0 || runs.length === 0) runs.push([row]);
        else runs[runs.length - 1]!.push(row);
    }
    return runs;
}

/**
 * One Project's rows with their live checkout facts. The section subscribes to its own checkouts' facts,
 * so a change to one checkout re-renders this Project only; the tree above keeps membership, focus and
 * keyboard order and is not involved.
 */
const ProjectsTreeLiveSection = React.memo(function ProjectsTreeLiveSection(props: Readonly<{
    rows: readonly ProjectsTreeRow[];
    live: ProjectsTreeLiveCheckouts;
    rowList: ProjectsTreeRowListProps;
    activeKey: string | null;
    /** The Project's place among the Projects: its row announces it, so a shift redraws this section. */
    position: Readonly<{ positionInSet: number; setSize: number }> | null;
}>) {
    const { live } = props;
    const project = live.projectsByKey.get(props.rows[0]!.key);
    const keys = (project?.checkouts ?? []).map(projectsTreeCheckoutKey);
    const facts = useProjectsTreeCheckoutFactsFor(live.source, keys);
    const rows = React.useMemo(() => project
        ? buildProjectsTreeRows({
            projects: [applyProjectsTreeCheckoutFacts(project, (_checkout, index) => facts[index] ?? null)],
            openRefId: live.openRefId,
            openEnvironmentId: live.openEnvironmentId,
            expandedKeys: live.expandedKeys,
            collapsedKeys: live.collapsedKeys,
        })
        : props.rows, [project, facts, live.openRefId, live.openEnvironmentId, live.expandedKeys, live.collapsedKeys, props.rows]);
    return <ProjectsTreeRowList rows={rows} activeKey={props.activeKey} {...props.rowList} />;
}, (previous, next) => {
    if (previous.rowList !== next.rowList || previous.activeKey !== next.activeKey || previous.live.source !== next.live.source) return false;
    if (previous.position?.positionInSet !== next.position?.positionInSet || previous.position?.setSize !== next.position?.setSize) return false;
    const key = next.rows[0]!.key;
    const project = next.live.projectsByKey.get(key);
    if (project !== previous.live.projectsByKey.get(key)) return false;
    if (!project) return previous.rows === next.rows;
    // Global selection/disclosure carriers are projected to this Project, just as facts are.
    const selectedRef = (openRefId: string | null) => project.checkouts.some(checkout => checkout.refId === openRefId) ? openRefId : null;
    if (selectedRef(previous.live.openRefId) !== selectedRef(next.live.openRefId)) return false;
    const selectedEnvironment = (environmentId: string | null | undefined) => environmentId
        && project.environments?.some(environment => environment.environmentId === environmentId) ? environmentId : null;
    if (selectedEnvironment(previous.live.openEnvironmentId) !== selectedEnvironment(next.live.openEnvironmentId)) return false;
    const sameDisclosure = (rowKey: string) => previous.live.expandedKeys.has(rowKey) === next.live.expandedKeys.has(rowKey)
        && (previous.live.collapsedKeys?.has(rowKey) === true) === (next.live.collapsedKeys?.has(rowKey) === true);
    return sameDisclosure(key) && project.checkouts.every(checkout => sameDisclosure(`${key}/${checkout.machineId}`));
});

/** The tree's leading anatomy: the row's mark on the column's text edge, in the row's glyph box. */
const TREE_GLYPH_PX = 16;
const PROJECTS_TREE_SKELETON_GEOMETRY = Object.freeze({
    insetStart: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    insetEnd: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    glyphColumn: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
    glyphSize: TREE_GLYPH_PX,
    gap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
});
const PROJECTS_TREE_SKELETON_ROW_BOX = Object.freeze({
    minHeight: HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight,
    paddingVertical: ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.compact,
});

/** A tree row's title and subtitle line heights in the user's font scale (its compact navigation row). */
function useProjectsTreeRowLineHeights() {
    const uiFontScale = useLocalSetting('uiFontScale');
    return React.useMemo(() => {
        const scaled = (lineHeight: number) => {
            const style = scaleTextStyle({ lineHeight }, uiFontScale) as { lineHeight?: number };
            return style.lineHeight ?? lineHeight;
        };
        return [scaled(ITEM_TITLE_TEXT_METRICS.compact.lineHeight), scaled(ITEM_SUBTITLE_TEXT_METRICS.compact.lineHeight)] as const;
    }, [uiFontScale]);
}

/**
 * The Projects tree's first load: the shared loading rows in the tree rows' own shape — a
 * compact navigation row with a subtitle, its glyph on the column's text edge, its title and subtitle at their
 * line heights in the user's font scale — so the rows that land replace them without a shift.
 */
export const ProjectsTreeSkeletonRows = React.memo(function ProjectsTreeSkeletonRows(props: Readonly<{ rows: number; testID?: string }>) {
    const lineHeights = useProjectsTreeRowLineHeights();
    return (
        <SkeletonRows
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            rows={props.rows}
            rowBox={PROJECTS_TREE_SKELETON_ROW_BOX}
            lineHeights={lineHeights}
            geometry={PROJECTS_TREE_SKELETON_GEOMETRY}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    count: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    hidden: {
        marginTop: theme.space.s12,
        paddingTop: theme.space.s8,
        borderTopWidth: StyleSheet.hairlineWidth || 1,
    },
}));
