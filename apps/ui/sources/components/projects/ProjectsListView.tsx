import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { NavigationTitleChromeProvider, PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import { usePhoneTabNavRow } from '@/components/navigation/shell/phoneTabNavRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useProjectsListModel } from './useProjectsListModel';
import { applyProjectsTreeCheckoutFacts, buildProjectsPhoneTreeRows, projectsTreeCheckoutKey, projectsTreeRowSubtitle, type ProjectsTreeProject, type ProjectsTreeRow } from './projectsTreeRows';
import { useProjectsTreeCheckoutFactsFor, useProjectsTreeCheckoutFactsSource, type ProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { ProjectsTree, useProjectsTreeKeyboard } from './ProjectsTree';
import { ProjectHideUndoNotice } from './ProjectHideUndoNotice';
import { ProjectsAddMenu } from './ProjectsAddMenu';
import { ProjectOpenResolutionCard, ProjectRowsStaleLine, openProjectCandidate, useProjectRowsRetry } from './ProjectOpenResolution';
import { ProjectActionApprovalNotice } from './ProjectActionApprovalNotice';
import { useProjectRowCreationActions } from './ProjectSaveAsSourceSheet';

const NO_KEYS: ReadonlySet<string> = new Set();
/** A disclosed checkout sits one leading column in, under its Project's name (lab p-projects TREEp). */
const LEAF_INDENT_PX = 32;

/**
 * The Projects page as a list: where the Projects column is not beside it (collapsed, and on phones).
 * The same Projects as the column's tree, folded to two levels for a phone (plan 10 §2): a Project,
 * and under it each checkout as "Machine · branch" with where it lives.
 */
export const ProjectsListView = React.memo(() => {
    const { theme } = useUnistyles();
    const model = useProjectsListModel();
    const rowCreation = useProjectRowCreationActions(model);
    const rowsRetry = useProjectRowsRetry();
    const { groups, hasAnyProjects } = model;
    const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [collapsedKeys, setCollapsedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [hiddenOpen, setHiddenOpen] = React.useState(false);

    const refsById = React.useMemo(() => new Map(
        groups.projectGroups.flatMap((group) => group.items.map((ref) => [JSON.stringify(workspaceAddressFromRefV1(ref)), ref] as const)),
    ), [groups.projectGroups]);
    // The list keeps membership, order and disclosure; each row reads its own checkouts' live facts.
    const factsSource = useProjectsTreeCheckoutFactsSource(model.checkoutRefs);
    const projects = model.treeProjects;
    const projectGroupsByKey = React.useMemo(() => new Map([...groups.projectGroups, ...groups.hiddenProjectGroups]
        .map(group => [group.projectKey.projectKey, group] as const)), [groups.projectGroups, groups.hiddenProjectGroups]);
    const hidden = React.useMemo(() => ({
        items: model.hiddenItems,
        open: hiddenOpen, onToggle: () => setHiddenOpen(open => !open),
        onShow: model.showHiddenProject,
    }), [model.hiddenItems, hiddenOpen, model.showHiddenProject]);
    const phoneTabShell = usePhoneTabNavRow() !== null;
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
    const openRow = React.useCallback((row: ProjectsTreeRow) => {
        const ref = row.workspaceAddress ? refsById.get(JSON.stringify(row.workspaceAddress)) ?? null : null;
        if (ref) model.openWorkspace(ref);
        else if (row.expandable) toggle(row.key, row.expanded);
    }, [model.openWorkspace, refsById, toggle]);
    // The phone rows are the same tree items as the column's, through the same shared tree owner.
    const keyboard = useProjectsTreeKeyboard(rows, {
        onToggle: (key) => toggle(key, rows.find((row) => row.key === key)?.expanded === true),
        onOpenRow: openRow,
    });

    return (
        <NavigationTitleChromeProvider showsTitle={false}>
        <ItemList presentation="grouped"
            testID="projects-list"
            containerStyle={phoneTabShell ? undefined : { paddingTop: theme.space.s12 }}
        >
            {/* The phone tab's head: the shell draws the Home line above, the page names itself here. */}
            {phoneTabShell ? <NavigationLargeTitleProvider largeTitle><PageHeader title={t('tabs.projects')} /></NavigationLargeTitleProvider> : null}
            {model.rowsUnconfirmed ? (
                <ProjectOpenResolutionCard testID="projects-list:rows" issue={model.rowsUnconfirmed}
                    onChoose={() => {}} onRetry={rowsRetry} />
            ) : !hasAnyProjects && !saved?.items.length ? (
                <EmptyState
                    testID="projects-list-empty"
                    scene="noProjects"
                    title={t('projects.emptyTitle')}
                    subtitle={t('projects.emptyDescription')}
                />
            ) : model.staleRows ? (
                <ProjectRowsStaleLine testID="projects-list:stale" asOf={model.staleRows.asOf} />
            ) : null}

            {rows.length > 0 ? (
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
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {model.projectOpenResolution ? (
                <ProjectOpenResolutionCard
                    testID="projects-list:open-resolution"
                    issue={model.projectOpenResolution}
                    onChoose={(candidate) => { openProjectCandidate(model.openProject, candidate); }}
                    action={{ label: t('common.close'), onPress: model.dismissProjectOpenResolution }}
                />
            ) : null}

            {/* The same "+" as the column and the none-open page: a folder, a clone, your Sources, each Team's, Manage. */}
            <ItemGroup>
                <ProjectsAddMenu
                    testID="projects-list:add"
                    machines={model.addFirstMachines}
                    onAdd={model.addProjectToMachine}
                    onClone={model.cloneRepository}
                    sources={model.addSources}
                    renderTrigger={(open) => (
                        <Item
                            testID="projects-list:add-row"
                            title={t('projects.actions.addProject')}
                            icon={<Icon name="plus" size={20} color={theme.colors.text.secondary} />}
                            onPress={open}
                        />
                    )}
                />
            </ItemGroup>

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
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
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
                <Icon name={row.expanded ? 'caret-down' : 'caret-right'} size={14} color={theme.colors.text.tertiary} />
            ) : null}
            {ref || hideGroup ? (
                <ProjectsListItemMenu
                    workspaceRef={ref}
                    pinAction={ref ? model.pinnedIdSet.has(ref.id) ? 'unpin' : 'pin' : null}
                    onTogglePinned={model.togglePinned}
                    onRename={model.renameProject}
                    onReset={model.resetProjectName}
                    onRemove={model.removeProject}
                    onNewSession={props.rowCreation.newSession}
                    onSaveAsSource={props.rowCreation.saveSource}
                    onHideProject={hideGroup ? () => { void model.setProjectHidden(hideGroup.projectKey, true); } : null}
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
            subtitleLines={ref ? model.workspaceSubtitleLines(ref) : 1}
            subtitleStyle={row.level > 0 ? styles.mono : undefined}
            icon={<Icon name={row.glyph === 'project' ? 'folder' : 'desktop'} size={20} color={theme.colors.text.secondary} />}
            accessibilityExpanded={row.expandable ? row.expanded : undefined}
            rightElement={trailing}
            style={row.level > 0 ? { paddingLeft: LEAF_INDENT_PX } : undefined}
            titleStyle={row.offline ? { color: theme.colors.text.secondary } : undefined}
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
    mono: {
        ...Typography.mono(),
    },
}));
