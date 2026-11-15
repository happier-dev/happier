import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    resolveHappierCollectionTreeChildIndentPx,
} from '@happier-dev/plugin-ui/presentation';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { DeploymentTreeRow } from './deployments/rows/DeploymentEnvironmentRow';
import { ProjectsTreeRowAttention } from './ProjectsTreeRowAttention';
import { CollectionListGroupLabel, CollectionNavigationRow, CollectionRowOrder } from '@/components/ui/lists/collection/CollectionList';
import { useCollectionTreeKeyboard } from '@/components/ui/lists/collection/useCollectionTreeKeyboard';
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
    projectsTreeRowChild,
    projectsTreeRowEnvironment,
    projectsTreeRowOpenTarget,
    projectsTreeRowSubtitle,
    type ProjectsTreeEnvironmentChild,
    type ProjectsTreeProject,
    type ProjectsTreeRow,
} from './projectsTreeRows';
import { useProjectsTreeCheckoutFactsFor, type ProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

/**
 * Opens a checkout; with an Environment, that Environment on the checkout's Project Deployments page; with a database
 * too, that database in its Environment.
 */
export type ProjectsTreeOpenRef = (refId: string, address?: WorkspaceAddressV1, environmentId?: string, database?: string) => void;

/**
 * Where a row's press (or Enter) lands: a leaf opens its exact checkout, a Project opens on its lead checkout, an
 * Environment (or one of its databases) opens on its Project's Deployments page, a service opens its page on its
 * Machine, and only a row with nothing to open (a machine) opens or closes in place. The one press owner for the
 * column and the phone list.
 */
export function openProjectsTreeRow(row: ProjectsTreeRow, onOpenRef: ProjectsTreeOpenRef, onToggle: (key: string) => void,
    onOpenHref?: ((href: string) => void) | null) {
    const child = projectsTreeRowChild(row);
    if (child?.kind === 'href') { onOpenHref?.(child.href); return; }
    const target = projectsTreeRowOpenTarget(row);
    const environment = projectsTreeRowEnvironment(row);
    if (target && environment && child?.kind === 'database') onOpenRef(target.refId, target.workspaceAddress, environment.environmentId, child.database);
    else if (target && environment) onOpenRef(target.refId, target.workspaceAddress, environment.environmentId);
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
    /** What each opened Environment runs, by Environment id (`useProjectsTreeEnvironmentChildren`). */
    environmentChildren?: ReadonlyMap<string, readonly ProjectsTreeEnvironmentChild[]>;
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
    /** A service row under an Environment: its page on its Machine. */
    onOpenHref?: ((href: string) => void) | null;
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
    | Readonly<{ kind: 'project'; key: string; rows: readonly ProjectsTreeRow[]; after: ProjectsTreeRunAfter }>
    | Readonly<{ kind: 'savedLabel'; key: string; count: number }>
    | Readonly<{ kind: 'saved'; key: string; item: ProjectsTreeSavedItem }>
    | Readonly<{ kind: 'hiddenHead'; key: string }>
    | Readonly<{ kind: 'hidden'; key: string; item: ProjectsTreeHiddenItem }>;

const projectsTreeItemKey = (item: ProjectsTreeItem) => item.key;

/** What follows a Project's rows: another Project (the one list-row rule runs under its last row), and whether it is the open one. */
type ProjectsTreeRunAfter = Readonly<{ followed: boolean; nextSelected: boolean }>;
const RUN_ENDS: ProjectsTreeRunAfter = Object.freeze({ followed: false, nextSelected: false });
const RUN_FOLLOWED: ProjectsTreeRunAfter = Object.freeze({ followed: true, nextSelected: false });
const RUN_BEFORE_SELECTED: ProjectsTreeRunAfter = Object.freeze({ followed: true, nextSelected: true });

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
    const { onOpenRef, onToggle, onOpenHref } = props;
    const keyboard = useCollectionTreeKeyboard(props.rows, {
        onToggle,
        onOpenRow: (row) => openProjectsTreeRow(row, onOpenRef, onToggle, onOpenHref),
        ...(onRevealIndex ? { onRevealIndex } : {}),
    });
    const liveInput = props.live;
    const live = React.useMemo((): ProjectsTreeLiveCheckouts | null => liveInput ? {
        ...liveInput,
        projectsByKey: new Map(liveInput.projects.map((project) => [project.key, project] as const)),
    } : null, [liveInput?.source, liveInput?.projects, liveInput?.openRefId, liveInput?.openEnvironmentId, liveInput?.expandedKeys, liveInput?.collapsedKeys, liveInput?.environmentChildren]);
    const handlersRef = React.useRef({ onOpenRef, onToggle, onOpenHref });
    handlersRef.current = { onOpenRef, onToggle, onOpenHref };
    // These callbacks run on user intent; changing a parent's closure does not change any row's presentation.
    const openRef = React.useCallback<ProjectsTreeOpenRef>((refId, address, environmentId, database) => (environmentId === undefined
        ? handlersRef.current.onOpenRef(refId, address) : database === undefined ? handlersRef.current.onOpenRef(refId, address, environmentId)
            : handlersRef.current.onOpenRef(refId, address, environmentId, database)), []);
    const toggle = React.useCallback((key: string) => handlersRef.current.onToggle(key), []);
    const openHref = React.useCallback((href: string) => handlersRef.current.onOpenHref?.(href), []);
    const rowListProps = React.useMemo((): ProjectsTreeRowListProps => ({
        testID,
        getRowProps: keyboard.getRowPropsForActiveKey,
        renderRowMenu: props.renderRowMenu,
        hrefForRef: props.hrefForRef,
        onOpenRef: openRef,
        onToggle: toggle,
        onOpenHref: openHref,
    }), [testID, keyboard.getRowPropsForActiveKey, props.renderRowMenu, props.hrefForRef, openRef, toggle, openHref]);
    const { saved, hidden } = props;
    const items = React.useMemo((): ProjectsTreeItem[] => {
        const runs = projectRuns(props.rows);
        const next: ProjectsTreeItem[] = runs.map((run, index) => {
            const following = runs[index + 1];
            const after = following === undefined ? RUN_ENDS : following[0]!.selected ? RUN_BEFORE_SELECTED : RUN_FOLLOWED;
            return { kind: 'project', key: `project:${run[0]!.key}`, rows: run, after };
        });
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
                    ? <ProjectsTreeLiveSection rows={item.rows} after={item.after} live={live} rowList={rowListProps}
                        activeKey={item.rows.some(row => row.key === activeKey) ? activeKey : null}
                        position={positionOf(item.rows[0]!.key)} />
                    : <ProjectsTreeRowList rows={item.rows} after={item.after} activeKey={activeKey} {...rowListProps} />;
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
    getRowProps: ReturnType<typeof useCollectionTreeKeyboard<ProjectsTreeRow>>['getRowPropsForActiveKey'];
    renderRowMenu?: ((row: ProjectsTreeRow) => React.ReactNode) | null;
    hrefForRef?: ((refId: string, address?: WorkspaceAddressV1) => string | null) | null;
    onOpenRef: ProjectsTreeOpenRef;
    onToggle: (key: string) => void;
    onOpenHref: (href: string) => void;
}>;

/**
 * The tree's rows as drawn: one shared row anatomy for every Project section. No disclosure column: every
 * mark keeps the column's text edge, a checkout steps in by one mark, and only a row with something to
 * disclose carries its chevron, at its end beside the count (owner 11-08).
 */
function ProjectsTreeRowList(props: ProjectsTreeRowListProps & Readonly<{ rows: readonly ProjectsTreeRow[]; after: ProjectsTreeRunAfter; activeKey: string | null }>) {
    const { theme } = useUnistyles();
    const renderRow = (row: ProjectsTreeRow) => {
                const target = projectsTreeRowOpenTarget(row);
                // An Environment and what it runs: the one Environment row (UI refinements ruling 2026-11-15 08:57Z),
                // shared with the Services column; the tree keeps its structure, selection, keyboard and where a press goes.
                if (row.kind === 'environment' || row.kind === 'service' || row.kind === 'database') {
                    return (
                        <DeploymentTreeRow
                            key={row.key}
                            testID={`${props.testID}-row-${row.key}`}
                            row={{ kind: row.kind, title: row.title, titleQualifier: row.titleQualifier ?? null, platform: row.platform === true,
                                state: row.state ?? null, fact: row.kind === 'environment' ? row.fact ?? null : row.subtitle ?? null }}
                            href={row.child?.kind === 'href' ? row.child.href : null}
                            disclosure={row.expandable ? { expanded: row.expanded, onToggle: () => props.onToggle(row.key) } : null}
                            selected={row.selected}
                            indentPx={row.level * resolveHappierCollectionTreeChildIndentPx()}
                            treeItem={props.getRowProps(row, props.activeKey)}
                            rightElement={props.renderRowMenu?.(row) ?? null}
                            onPress={() => openProjectsTreeRow(row, props.onOpenRef, props.onToggle, props.onOpenHref)}
                        />
                    );
                }
                const status = row.attention || row.state ? <ProjectsTreeRowAttention row={row} testID={`${props.testID}-${row.key}`} /> : undefined;
                return (
                    <CollectionNavigationRow
                        key={row.key}
                        testID={`${props.testID}-row-${row.key}`}
                        href={row.child?.kind === 'href' ? row.child.href
                            : target && !row.environment ? props.hrefForRef?.(target.refId, target.workspaceAddress) ?? null : null}
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
                        count={row.count}
                        selected={row.selected}
                        dimmed={row.offline === true}
                        indentPx={row.level * resolveHappierCollectionTreeChildIndentPx()}
                        treeItem={props.getRowProps(row, props.activeKey)}
                        accessibilityLabel={row.titleQualifier ? `${row.title}, ${row.titleQualifier}` : row.title}
                        rightElement={props.renderRowMenu?.(row) ?? null}
                        onPress={() => openProjectsTreeRow(row, props.onOpenRef, props.onToggle, props.onOpenHref)}
                    />
                );
    };
    // The one list-row rule runs between the tree's rows, into the next Project's, never beside the open row.
    return (
        <>
            {props.rows.map((row, index) => {
                const next = props.rows[index + 1];
                return (
                    <CollectionRowOrder key={row.key} followed={next !== undefined || props.after.followed}
                        precedesSelected={next === undefined ? props.after.nextSelected : next.selected}>
                        {renderRow(row)}
                    </CollectionRowOrder>
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
    after: ProjectsTreeRunAfter;
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
            environmentChildren: live.environmentChildren,
        })
        : props.rows, [project, facts, live.openRefId, live.openEnvironmentId, live.expandedKeys, live.collapsedKeys, live.environmentChildren, props.rows]);
    return <ProjectsTreeRowList rows={rows} after={props.after} activeKey={props.activeKey} {...props.rowList} />;
}, (previous, next) => {
    if (previous.rowList !== next.rowList || previous.activeKey !== next.activeKey || previous.live.source !== next.live.source) return false;
    if (previous.after !== next.after) return false;
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
    // An Environment's disclosure and what it runs belong to its Project alone.
    return sameDisclosure(key) && project.checkouts.every(checkout => sameDisclosure(`${key}/${checkout.machineId}`))
        && (project.environments ?? []).every(environment => sameDisclosure(`${key}/environment/${environment.environmentId}`)
            && previous.live.environmentChildren?.get(environment.environmentId) === next.live.environmentChildren?.get(environment.environmentId));
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
