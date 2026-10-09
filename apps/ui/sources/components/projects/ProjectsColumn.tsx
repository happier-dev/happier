import * as React from 'react';
import { View } from 'react-native';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { destinationRowTestId, useColumnDestinations } from '@/components/appShell/destinations/ColumnDestinationRows';
import { Icon } from '@/components/ui/icons/Icon';
import {
    CollectionList,
    CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { t } from '@/text';

import { ProjectsAddMenu } from './ProjectsAddMenu';
import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { useProjectsListModel } from './useProjectsListModel';
import { ProjectsTree } from './ProjectsTree';
import { ProjectHideUndoNotice } from './ProjectHideUndoNotice';
import { ProjectOpenResolutionCard, openProjectCandidate } from './ProjectOpenResolution';
import { ProjectActionApprovalNotice } from './ProjectActionApprovalNotice';
import { useProjectRowCreationActions } from './ProjectSaveAsSourceSheet';
import { buildProjectsTreeRows, type ProjectsTreeRow } from './projectsTreeRows';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1, type WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces';

const NO_KEYS: ReadonlySet<string> = new Set();

/** The project a `/projects/<id>…` route has open, or `null` on the index. */
function readOpenProjectId(pathname: string): string | null {
    const match = /^\/projects\/([^/]+)/.exec(pathname);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]!);
    } catch {
        return match[1]!;
    }
}

/**
 * The Projects destination's column (design §3.2, lab p-projects TREE): each Project with its machines
 * and checkouts as one tree (`buildProjectsTreeRows`), the open checkout selected and its Project open;
 * "+" adds one. It reads the same model as the Projects page, so the column and the page never disagree.
 */
export const ProjectsColumn = React.memo(function ProjectsColumn() {
    const { theme } = useUnistyles();
    const pathname = usePathname();
    const model = useProjectsListModel();
    const { newSession, saveSource } = useProjectRowCreationActions(model);
    const placed = useColumnDestinations('projects');
    const openId = readOpenProjectId(pathname);
    const { openWorkspace, setProjectHidden, pinnedIdSet, togglePinned, renameProject, resetProjectName, removeProject } = model;

    const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [collapsedKeys, setCollapsedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const refsById = React.useMemo(() => new Map(
        [...model.groups.projectGroups, ...model.groups.hiddenProjectGroups].flatMap((group) => group.items.map((ref) => [JSON.stringify(workspaceAddressFromRefV1(ref)), ref] as const)),
    ), [model.groups.hiddenProjectGroups, model.groups.projectGroups]);
    const projects = model.treeProjects;
    const rows = React.useMemo(
        () => buildProjectsTreeRows({ projects, openRefId: openId, expandedKeys, collapsedKeys }),
        [collapsedKeys, expandedKeys, openId, projects],
    );
    const toggle = React.useCallback((key: string) => {
        const open = rows.find((row) => row.key === key)?.expanded === true;
        const without = (set: ReadonlySet<string>) => { const next = new Set(set); next.delete(key); return next; };
        const withKey = (set: ReadonlySet<string>) => new Set([...set, key]);
        setExpandedKeys((current) => (open ? without(current) : withKey(current)));
        setCollapsedKeys((current) => (open ? withKey(current) : without(current)));
    }, [rows]);
    const openRef = React.useCallback((refId: string, address?: WorkspaceAddressV1) => {
        if (!address || address.workspaceId !== refId) return;
        const resolution = resolveWorkspaceRefByAddress([...refsById.values()], address);
        if (resolution.kind === 'resolved') openWorkspace(resolution.ref);
    }, [openWorkspace, refsById]);
    const hrefForRef = React.useCallback((refId: string, address?: WorkspaceAddressV1) => address
        ? `/projects/${encodeURIComponent(refId)}?serverId=${encodeURIComponent(address.serverId)}` : null, []);
    const projectRefByKey = React.useMemo(() => new Map(
        [...model.groups.projectGroups, ...model.groups.hiddenProjectGroups].flatMap((group) => group.items[0] ? [[group.projectKey.projectKey, group] as const] : []),
    ), [model.groups.hiddenProjectGroups, model.groups.projectGroups]);
    const renderRowMenu = React.useCallback((row: ProjectsTreeRow) => {
        const ref = row.workspaceAddress ? refsById.get(JSON.stringify(row.workspaceAddress)) ?? null : null;
        const project = row.kind === 'project' ? projectRefByKey.get(row.key) ?? null : null;
        if (!ref && !project) return null;
        return (
            <ProjectsListItemMenu
                theme={theme}
                workspaceRef={ref}
                pinAction={ref ? (pinnedIdSet.has(ref.id) ? 'unpin' : 'pin') : null}
                onTogglePinned={togglePinned}
                onRename={renameProject}
                onReset={resetProjectName}
                onRemove={removeProject}
                onNewSession={newSession}
                onSaveAsSource={saveSource}
                // A Project row hides the whole Project; a checkout row under it keeps its own actions.
                onHideProject={project ? () => { void setProjectHidden(project.projectKey, true); } : null}
            />
        );
    }, [newSession, saveSource, pinnedIdSet, projectRefByKey, refsById, removeProject, renameProject, resetProjectName, setProjectHidden, theme, togglePinned]);
    // Saved-not-open Sources after the tree and the "+" composition: one owner for every Projects entrance.
    const { addSources, saved, cloneRepository } = model;
    const [hiddenOpen, setHiddenOpen] = React.useState(false);
    const hidden = React.useMemo(() => {
        const hiddenProjects = model.hiddenTreeProjects;
        return {
            items: hiddenProjects.map((project) => {
                const first = project.checkouts[0]!;
                return { key: project.key, title: project.name, subtitle: `${first.machineName} · ${first.path}` };
            }),
            open: hiddenOpen,
            onToggle: () => setHiddenOpen((open) => !open),
            onShow: (key: string) => {
                const group = projectRefByKey.get(key);
                if (group) void setProjectHidden(group.projectKey, false);
            },
        };
    }, [hiddenOpen, model.hiddenTreeProjects, projectRefByKey, setProjectHidden]);

    return (
        <View testID="projects-column" style={styles.column}>
            <CollectionList
                testID="projects-column:list"
                surface="plane"
                title={t('tabs.projects')}
                // A count speaks only once there is something to count (lab `treeCol`: no "0").
                count={model.projectCount > 0 ? model.projectCount : undefined}
                headerAction={(
                    <ProjectsAddMenu
                        testID="projects-column:add"
                        machines={model.addFirstMachines}
                        onAdd={model.addProjectToMachine}
                        onClone={cloneRepository}
                        sources={addSources}
                    />
                )}
            >
                {placed.destinations.map((destination) => (
                    <CollectionNavigationRow
                        key={destination.id}
                        href={destination.activation === 'navigate' ? destination.routePath : null}
                        testID={destinationRowTestId(destination)}
                        title={destination.title}
                        icon={<Icon name={destination.icon} />}
                        selected={destination.id === placed.currentId}
                        onPress={() => placed.activate(destination)}
                    />
                ))}
                <ProjectsTree
                    testID="projects-column:tree"
                    rows={rows}
                    onToggle={toggle}
                    onOpenRef={openRef}
                    hrefForRef={hrefForRef}
                    renderRowMenu={renderRowMenu}
                    hidden={hidden}
                    saved={saved}
                />
                {model.projectOpenResolution ? (
                    <ProjectOpenResolutionCard
                        testID="projects-column:open-resolution"
                        issue={model.projectOpenResolution}
                        onChoose={(candidate) => { openProjectCandidate(model.openProject, candidate); }}
                        action={{ label: t('common.close'), onPress: model.dismissProjectOpenResolution }}
                    />
                ) : null}
                <ProjectActionApprovalNotice testID="projects-column:approval" request={model.projectActionApproval} onDismiss={model.dismissProjectActionApproval} />
                <ProjectHideUndoNotice testID="projects-column:hide-undo" undo={model.projectHideUndo} onDismiss={model.dismissProjectHideUndo} />
            </CollectionList>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    column: {
        flex: 1,
        minHeight: 0,
    },
}));
