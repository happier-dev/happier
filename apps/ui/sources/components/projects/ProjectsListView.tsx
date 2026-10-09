import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { useProjectsListModel } from './useProjectsListModel';
import { buildProjectsPhoneTreeRows, type ProjectsTreeRow } from './projectsTreeRows';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { ProjectsTree, useProjectsTreeKeyboard } from './ProjectsTree';
import { ProjectHideUndoNotice } from './ProjectHideUndoNotice';
import { ProjectsAddMenu } from './ProjectsAddMenu';
import { ProjectOpenResolutionCard, openProjectCandidate } from './ProjectOpenResolution';
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
    const { groups, hasAnyProjects } = model;
    const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [collapsedKeys, setCollapsedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [hiddenOpen, setHiddenOpen] = React.useState(false);

    const refsById = React.useMemo(() => new Map(
        groups.projectGroups.flatMap((group) => group.items.map((ref) => [JSON.stringify(workspaceAddressFromRefV1(ref)), ref] as const)),
    ), [groups.projectGroups]);
    const projects = model.treeProjects;
    const projectGroupsByKey = React.useMemo(() => new Map([...groups.projectGroups, ...groups.hiddenProjectGroups]
        .map(group => [group.projectKey.projectKey, group] as const)), [groups.projectGroups, groups.hiddenProjectGroups]);
    const hidden = React.useMemo(() => ({
        items: model.hiddenTreeProjects.map(project => ({ key: project.key, title: project.name,
            subtitle: `${project.checkouts[0]!.machineName} · ${project.checkouts[0]!.path}` })),
        open: hiddenOpen, onToggle: () => setHiddenOpen(open => !open),
        onShow: (key: string) => { const group = projectGroupsByKey.get(key); if (group) void model.setProjectHidden(group.projectKey, false); },
    }), [model.hiddenTreeProjects, hiddenOpen, model.setProjectHidden, projectGroupsByKey]);
    // Saved, not open (lab p-projects TREEp): the same composition as the column's.
    const { saved } = model;
    const rows = React.useMemo(() => buildProjectsPhoneTreeRows({
        projects,
        openRefId: null,
        expandedKeys,
        collapsedKeys,
        describe: {
            checkoutCount: (count) => t('projects.sources.checkoutWorktrees', { count }),
            machineCount: (count) => t('projects.identity.machineCount', { count }),
            offlineCount: (count) => t('projects.identity.offlineCount', { count }),
        },
    }), [collapsedKeys, expandedKeys, projects]);
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
        <ItemList presentation="grouped"
            testID="projects-list"
            containerStyle={{ paddingTop: 12 }}
        >
            {!hasAnyProjects && !saved?.items.length ? (
                <EmptyState
                    testID="projects-list-empty"
                    scene="noProjects"
                    title={t('projects.emptyTitle')}
                    subtitle={t('projects.emptyDescription')}
                />
            ) : null}

            {rows.length > 0 ? (
                <ItemGroup>
                    {rows.map((row) => {
                        const ref = row.workspaceAddress ? refsById.get(JSON.stringify(row.workspaceAddress)) ?? null : null;
                        const project = row.kind === 'project' ? projectGroupsByKey.get(row.key) : undefined;
                        const attentionLabel = ref ? model.workspaceAttentionLabel(ref) : null;
                        const subtitle = [row.subtitle, attentionLabel].filter((part): part is string => Boolean(part)).join(' · ');
                        const trailing = (
                            <View style={styles.trailing}>
                                {row.count != null ? <Text style={styles.count}>{String(row.count)}</Text> : null}
                                {row.attention === 'needs-you' ? (
                                    <View style={[styles.dot, { backgroundColor: theme.colors.state.warning.foreground }]} />
                                ) : row.attention === 'working' ? (
                                    <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
                                ) : null}
                                {row.expandable ? (
                                    <Icon name={row.expanded ? 'caret-down' : 'caret-right'} size={14} color={theme.colors.text.tertiary} />
                                ) : null}
                                {ref || project ? (
                                    <ProjectsListItemMenu
                                        theme={theme}
                                        workspaceRef={ref}
                                        pinAction={ref ? model.pinnedIdSet.has(ref.id) ? 'unpin' : 'pin' : null}
                                        onTogglePinned={model.togglePinned}
                                        onRename={model.renameProject}
                                        onReset={model.resetProjectName}
                                        onRemove={model.removeProject}
                                        onNewSession={rowCreation.newSession}
                                        onSaveAsSource={rowCreation.saveSource}
                                        onHideProject={project ? () => { void model.setProjectHidden(project.projectKey, true); } : null}
                                    />
                                ) : null}
                            </View>
                        );
                        return (
                            <Item
                                key={row.key}
                                testID={ref ? `projects-list-item-${ref.id}` : `projects-list-project-${row.key}`}
                                title={row.title}
                                titleAccessory={row.titleQualifier ? <Text numberOfLines={1} style={styles.qualifier}>{row.titleQualifier}</Text> : undefined}
                                subtitle={subtitle || undefined}
                                subtitleLines={ref ? model.workspaceSubtitleLines(ref) : 1}
                                subtitleStyle={row.level > 0 ? styles.mono : undefined}
                                icon={<Icon name={row.glyph === 'project' ? 'folder' : 'desktop'} size={20} color={theme.colors.text.secondary} />}
                                accessibilityExpanded={row.expandable ? row.expanded : undefined}
                                rightElement={trailing}
                                style={row.level > 0 ? { paddingLeft: LEAF_INDENT_PX } : undefined}
                                titleStyle={row.offline ? { color: theme.colors.text.secondary } : undefined}
                                {...keyboard.getRowProps(row)}
                                onPress={() => openRow(row)}
                            />
                        );
                    })}
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

            <ProjectsTree testID="projects-list-organization" rows={[]} onOpenRef={() => {}} onToggle={() => {}} hidden={hidden} saved={saved} />
            <ProjectActionApprovalNotice testID="projects-list:approval" request={model.projectActionApproval} onDismiss={model.dismissProjectActionApproval} />
            <ProjectHideUndoNotice testID="projects-list:hide-undo" undo={model.projectHideUndo} onDismiss={model.dismissProjectHideUndo} />

        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    count: {
        ...Typography.rowMeta(),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
    qualifier: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        marginLeft: 6,
    },
    mono: {
        ...Typography.mono(),
    },
}));
