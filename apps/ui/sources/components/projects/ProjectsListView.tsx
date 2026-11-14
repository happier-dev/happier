import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/PageHeader';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { CollectionCreateButton } from '@/components/ui/lists/collection/CollectionList';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierTreeDisclosure } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useProjectsListModel } from './useProjectsListModel';
import { applyProjectsTreeCheckoutFacts, buildProjectsPhoneTreeRows, filterProjectsTreeByQuery, projectsTreeCheckoutKey, projectsTreeGlyphIcon, projectsTreeRowSubtitle, type ProjectsTreeProject, type ProjectsTreeRow } from './projectsTreeRows';
import { useProjectsTreeEnvironments } from './useProjectsTreeEnvironments';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { useProjectsTreeCheckoutFactsFor, useProjectsTreeCheckoutFactsSource, type ProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { ProjectsTree, openProjectsTreeRow, useProjectsTreeKeyboard } from './ProjectsTree';
import { ProjectHideUndoNotice } from './ProjectHideUndoNotice';
import { ProjectsAddMenu } from './ProjectsAddMenu';
import { useOpenNewApp } from './starters/newAppPresentation';
import { ProjectOpenResolutionCard, ProjectRowsStaleLine, openProjectCandidate, useProjectRowsRetry } from './ProjectOpenResolution';
import { ProjectActionApprovalNotice } from './ProjectActionApprovalNotice';
import { useProjectRowCreationActions } from './ProjectSaveAsSourceSheet';

const NO_KEYS: ReadonlySet<string> = new Set();
/** A disclosed checkout sits one leading column in, under its Project's name (lab p-projects TREEp). */
const LEAF_INDENT_PX = 32;
const PHONE_DISCLOSURE_HIT_REACH = Object.freeze({ top: 12, bottom: 12, left: 5, right: 5 });

/**
 * The Projects page as a list: where the Projects column is not beside it (collapsed, and on phones).
 * The same Projects as the column's tree, folded to two levels for a phone (plan 10 §2): a Project,
 * and under it each checkout as "Machine · branch" with where it lives.
 */
export const ProjectsListView = React.memo(() => {
    const model = useProjectsListModel();
    const openNewApp = useOpenNewApp(model.cloneRepository);
    const rowCreation = useProjectRowCreationActions(model);
    const rowsRetry = useProjectRowsRetry();
    const { groups } = model;
    const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [collapsedKeys, setCollapsedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [hiddenOpen, setHiddenOpen] = React.useState(false);

    const refsById = React.useMemo(() => new Map(
        groups.projectGroups.flatMap((group) => group.items.map((ref) => [JSON.stringify(workspaceAddressFromRefV1(ref)), ref] as const)),
    ), [groups.projectGroups]);
    // The list keeps membership, order and disclosure; each row reads its own checkouts' live facts.
    const factsSource = useProjectsTreeCheckoutFactsSource(model.checkoutRefs);
    const [query, setQuery] = React.useState('');
    // The same Environments the column lists under each Project (pfc-redesign dProject tree).
    const treeProjects = useProjectsTreeEnvironments(model.treeProjects);
    const projects = React.useMemo(() => filterProjectsTreeByQuery(treeProjects, query), [treeProjects, query]);
    const projectGroupsByKey = React.useMemo(() => new Map([...groups.projectGroups, ...groups.hiddenProjectGroups]
        .map(group => [group.projectKey.projectKey, group] as const)), [groups.projectGroups, groups.hiddenProjectGroups]);
    const hidden = React.useMemo(() => ({
        items: model.hiddenItems,
        open: hiddenOpen, onToggle: () => setHiddenOpen(open => !open),
        onShow: model.showHiddenProject,
    }), [model.hiddenItems, hiddenOpen, model.showHiddenProject]);
    // The page's one add (a folder, a clone, your Sources, each Team's, Manage): the title row's "+" opens it, and the
    // bar's "+" opens the same menu (owner 11-11: it replaces the inline Add project row).
    const openAddRef = React.useRef<(() => void) | null>(null);
    const addLabel = t('projects.actions.addProject');
    const create = React.useMemo<PageCreateAction>(() => ({
        label: addLabel, testID: 'projects-add', onPress: () => openAddRef.current?.(),
    }), [addLabel]);
    const addMenu = (renderTrigger: (open: () => void) => React.ReactNode) => (
        <ProjectsAddMenu
            testID="projects-list:add"
            machines={model.addFirstMachines}
            onAdd={model.addProjectToMachine}
            onClone={model.cloneRepository}
            onNewApp={openNewApp}
            sources={model.addSources}
            fromSessions={model.fromSessions}
            renderTrigger={renderTrigger}
        />
    );
    // Saved, not open (lab p-projects TREEp): the same composition as the column's.
    const { saved } = model;
    const rows = React.useMemo(
        () => buildPhoneRows(projects, expandedKeys, collapsedKeys),
        [collapsedKeys, expandedKeys, projects],
    );
    const projectOfRow = React.useMemo(() => {
        const byKey = new Map(projects.map(project => [project.key, project] as const));
        const owners = new Map<string, ProjectsTreeProject>();
        let current: ProjectsTreeProject | undefined;
        for (const row of rows) {
            if (row.level === 0) current = byKey.get(row.key);
            if (current) owners.set(row.key, current);
        }
        return owners;
    }, [projects, rows]);
    const toggle = React.useCallback((key: string, open: boolean) => {
        const without = (set: ReadonlySet<string>) => { const next = new Set(set); next.delete(key); return next; };
        const withKey = (set: ReadonlySet<string>) => new Set([...set, key]);
        setExpandedKeys((current) => (open ? without(current) : withKey(current)));
        setCollapsedKeys((current) => (open ? withKey(current) : without(current)));
    }, []);
    // The column's press owner: a Project opens on its lead checkout, a checkout opens itself.
    const openRow = React.useCallback((row: ProjectsTreeRow) => {
        openProjectsTreeRow(row, model.openTreeRef, (key) => toggle(key, row.expanded));
    }, [model.openTreeRef, toggle]);
    const toggleRow = React.useCallback((row: ProjectsTreeRow) => toggle(row.key, row.expanded), [toggle]);
    // The phone rows are the same tree items as the column's, through the same shared tree owner.
    const keyboard = useProjectsTreeKeyboard(rows, {
        onToggle: (key) => toggle(key, rows.find((row) => row.key === key)?.expanded === true),
        onOpenRow: openRow,
    });

    return (
        <NavigationTitleChromeProvider showsTitle={false}>
        <ItemList presentation="grouped"
            testID="projects-list"
        >
            {/* The page's head wherever it is the whole page (a phone tab, a collapsed column): the main-screen head,
                which opens on the Home line on a phone (F2/F4). */}
            <MainScreenHeader
                testID="projects-header"
                title={t('tabs.projects')}
                search={{ value: query, onChangeText: setQuery, placeholder: t('projects.searchPlaceholder'), testID: 'projects-search' }}
                // The same count the Projects column shows, from the list's owner.
                {...(model.projectCount > 0 ? { count: [t('projects.projectCount', { count: model.projectCount })] } : {})}
                create={create}
                createTrigger={addMenu((open) => {
                    openAddRef.current = open;
                    return <CollectionCreateButton create={{ ...create, onPress: open }} />;
                })}
            />
            {model.rowsUnconfirmed ? (
                <ProjectOpenResolutionCard testID="projects-list:rows" issue={model.rowsUnconfirmed}
                    onChoose={() => {}} onRetry={rowsRetry} />
            ) : model.noProjects ? (
                <EmptyState
                    testID="projects-list-empty"
                    scene="noProjects"
                    title={t('projects.emptyTitle')}
                    subtitle={t('projects.emptyDescription')}
                />
            ) : model.staleRows ? (
                <ProjectRowsStaleLine testID="projects-list:stale" asOf={model.staleRows.asOf} />
            ) : null}

            {/* The rows are the tree's treeitems (`useProjectsTreeKeyboard`), so the tree contains them, as in the column. */}
            {rows.length > 0 ? (
                <View testID="projects-list:tree" {...(Platform.OS === 'web' ? { role: 'tree' as const } : {})}>
                    <ItemGroup>
                        {rows.map((row) => (
                            <ProjectsListRow
                                key={row.key}
                                row={row}
                                project={projectOfRow.get(row.key)!}
                                source={factsSource}
                                expandedKeys={expandedKeys}
                                collapsedKeys={collapsedKeys}
                                model={model}
                                rowCreation={rowCreation}
                                refsById={refsById}
                                hideGroup={row.kind === 'project' ? projectGroupsByKey.get(row.key) : undefined}
                                rowProps={keyboard.getRowProps(row)}
                                onOpenRow={openRow}
                                onToggleRow={toggleRow}
                            />
                        ))}
                    </ItemGroup>
                </View>
            ) : null}

            {model.projectOpenResolution ? (
                <ProjectOpenResolutionCard
                    testID="projects-list:open-resolution"
                    issue={model.projectOpenResolution}
                    onChoose={(candidate) => { openProjectCandidate(model.openProject, candidate); }}
                    action={{ label: t('common.close'), onPress: model.dismissProjectOpenResolution }}
                />
            ) : null}

            {query.trim().length > 0 && rows.length === 0 && !model.noProjects ? (
                <ItemGroup>
                    <Item testID="projects-list:no-matches" title={t('common.noMatches')} showChevron={false} />
                </ItemGroup>
            ) : null}

            <ProjectsTree testID="projects-list-organization" rows={[]} onOpenRef={model.openTreeRef} onToggle={() => {}} hidden={hidden} saved={saved} />
            <ProjectActionApprovalNotice testID="projects-list:approval" request={model.projectActionApproval} onDismiss={model.dismissProjectActionApproval} />
            <ProjectHideUndoNotice testID="projects-list:hide-undo" undo={model.projectHideUndo} onDismiss={model.dismissProjectHideUndo} />

        </ItemList>
        </NavigationTitleChromeProvider>
    );
});

function buildPhoneRows(
    projects: readonly ProjectsTreeProject[],
    expandedKeys: ReadonlySet<string>,
    collapsedKeys: ReadonlySet<string>,
): ProjectsTreeRow[] {
    return buildProjectsPhoneTreeRows({
        projects,
        openRefId: null,
        expandedKeys,
        collapsedKeys,
        describe: {
            checkoutCount: (count) => t('projects.sources.checkoutWorktrees', { count }),
            machineCount: (count) => t('projects.identity.machineCount', { count }),
            offlineCount: (count) => t('projects.identity.offlineCount', { count }),
        },
    });
}

/**
 * One phone row. It reads the live facts of its own checkouts (a Project row: all of its Project's; a
 * checkout row: its own), so a fact change re-renders the rows it touches and nothing else. The list
 * keeps membership, order and disclosure; the Item group hands each row its `showDivider`.
 */
function ProjectsListRow(props: Readonly<{
    row: ProjectsTreeRow;
    project: ProjectsTreeProject;
    source: ProjectsTreeCheckoutFactsSource;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys: ReadonlySet<string>;
    model: ReturnType<typeof useProjectsListModel>;
    rowCreation: ReturnType<typeof useProjectRowCreationActions>;
    refsById: ReadonlyMap<string, WorkspaceRefV1>;
    /** The Project's group when this is its Project row (what Hide acts on). */
    hideGroup: ReturnType<typeof useProjectsListModel>['groups']['projectGroups'][number] | undefined;
    rowProps: ReturnType<ReturnType<typeof useProjectsTreeKeyboard>['getRowProps']>;
    onOpenRow: (row: ProjectsTreeRow) => void;
    /** Only the chevron discloses: the row itself opens the Project. */
    onToggleRow: (row: ProjectsTreeRow) => void;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { model, hideGroup } = props;
    const owned = props.row.kind === 'project'
        ? props.project.checkouts
        : props.project.checkouts.filter(checkout => props.row.key === `${props.project.key}/${projectsTreeCheckoutKey(checkout)}`);
    const facts = useProjectsTreeCheckoutFactsFor(props.source, owned.map(projectsTreeCheckoutKey));
    const factsByKey = new Map(owned.map((checkout, index) => [projectsTreeCheckoutKey(checkout), facts[index] ?? null] as const));
    const row = buildPhoneRows(
        [applyProjectsTreeCheckoutFacts(props.project, checkout => factsByKey.get(projectsTreeCheckoutKey(checkout)) ?? null)],
        props.expandedKeys, props.collapsedKeys,
    ).find(candidate => candidate.key === props.row.key) ?? props.row;
    const ref = row.workspaceAddress ? props.refsById.get(JSON.stringify(row.workspaceAddress)) ?? null : null;
    const attentionLabel = ref ? model.workspaceAttentionLabel(ref) : null;
    // The person's grouping (owner 11-08): a Project row moves whole; a checkout moves alone and may separate.
    const leaf = row.kind === 'checkout';
    const { readGroupTargets, groupCheckouts } = model;
    const projectKey = props.project.key;
    const checkouts = props.project.checkouts;
    const grouping = React.useMemo(() => {
        const members = leaf ? (ref ? [ref] : []) : checkouts.flatMap(checkout => {
            const member = checkout.workspaceAddress ? props.refsById.get(JSON.stringify(checkout.workspaceAddress)) : undefined;
            return member ? [member] : [];
        });
        if (members.length === 0) return null;
        return {
            targets: () => readGroupTargets(projectKey),
            onGroup: (target: string) => { void groupCheckouts(members, target); },
            onSeparate: leaf && ref && checkouts.length > 1 ? () => { void groupCheckouts([ref], 'self'); } : null,
        };
    }, [checkouts, groupCheckouts, leaf, projectKey, props.refsById, readGroupTargets, ref]);
    const subtitle = [projectsTreeRowSubtitle(row, t('projects.identity.newFromSession')), attentionLabel].filter((part): part is string => Boolean(part)).join(' · ');
    const trailing = (
        <View style={styles.trailing}>
            {row.count != null ? <Text style={styles.count}>{String(row.count)}</Text> : null}
            {row.attention === 'needs-you' ? (
                <StatusDot color={theme.colors.state.warning.foreground} size={6} accessibilityLabel={t('projects.checkouts.needsYou')} />
            ) : row.attention === 'working' ? (
                <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
            ) : null}
            {row.expandable ? (
                <HappierTreeDisclosure
                    testID={`projects-list-project-${row.key}:disclosure`}
                    kind="branch"
                    expanded={row.expanded}
                    color={theme.colors.text.tertiary}
                    activeColor={theme.colors.text.secondary}
                    reducedMotion={reducedMotion}
                    accessibilityLabel={row.expanded ? t('common.collapse') : t('common.expand')}
                    // A finger reaches it across the row's height and the trailing gap on each side.
                    hitReach={PHONE_DISCLOSURE_HIT_REACH}
                    onPress={() => props.onToggleRow(row)}
                />
            ) : null}
            {ref || hideGroup ? (
                <ProjectsListItemMenu
                    workspaceRef={ref}
                    project={hideGroup?.projectKey}
                    pinAction={ref ? model.pinnedIdSet.has(ref.id) ? 'unpin' : 'pin' : null}
                    onTogglePinned={model.togglePinned}
                    onRename={model.renameProject}
                    onReset={model.resetProjectName}
                    onRemove={model.removeProject}
                    onNewSession={props.rowCreation.newSession}
                    onSaveAsSource={props.rowCreation.saveSource}
                    onHideProject={hideGroup ? () => { void model.setProjectHidden(hideGroup.projectKey, true); } : null}
                    grouping={grouping}
                />
            ) : null}
        </View>
    );
    return (
        <Item
            testID={ref ? `projects-list-item-${ref.id}` : `projects-list-project-${row.key}`}
            title={row.title}
            titleQualifier={row.titleQualifier}
            subtitle={subtitle || undefined}
            subtitleLeading={row.needsYouStatus ? <WorkStatusRowMark status={row.needsYouStatus} testIDSuffix={`projects-list-project-${row.key}`} /> : undefined}
            subtitleLines={ref ? model.workspaceSubtitleLines(ref) : 1}
            icon={<Icon name={projectsTreeGlyphIcon(row.glyph)} size={20} color={theme.colors.text.secondary} />}
            accessibilityExpanded={row.expandable ? row.expanded : undefined}
            rightElement={trailing}
            style={row.level > 0 ? { paddingLeft: LEAF_INDENT_PX } : undefined}
            dimmed={row.offline}
            showDivider={props.showDivider}
            {...props.rowProps}
            onPress={() => props.onOpenRow(row)}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    count: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
}));
