import * as React from 'react';
import { View } from 'react-native';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { destinationRowTestId, useColumnDestinations } from '@/components/appShell/destinations/ColumnDestinationRows';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import {
    CollectionList,
    collectionListStyles,
    CollectionNavigationRow,
    CollectionRows,
} from '@/components/ui/lists/collection/CollectionList';
import { t } from '@/text';

import { ProjectsAddMenu } from './ProjectsAddMenu';
import { useOpenNewApp } from './starters/newAppPresentation';
import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { useProjectsListModel, type ProjectsListModel } from './useProjectsListModel';
import { useIsWorkspaceRefPinned } from '@/sync/store/hooks';
import { ProjectsTreeList, ProjectsTreeSkeletonRows } from './ProjectsTree';
import { ProjectHideUndoNotice } from './ProjectHideUndoNotice';
import { ProjectOpenResolutionCard, ProjectRowsStaleLine, isProjectRowsPending, openProjectCandidate, useProjectRowsRetry } from './ProjectOpenResolution';
import { ProjectActionApprovalNotice } from './ProjectActionApprovalNotice';
import { useProjectRowCreationActions } from './ProjectSaveAsSourceSheet';
import { buildProjectsTreeRows, filterProjectsTreeByQuery, type ProjectsTreeRow } from './projectsTreeRows';
import { useProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import { useProjectsTreeOpenEnvironmentId } from './useProjectsTreeEnvironments';
import { ProjectsTreeEnvironmentReads, useProjectsTreeEnvironmentChildren } from './ProjectsTreeEnvironmentReads';
import { projectWorkspaceRefV1, workspaceAddressFromRefV1, type WorkspaceAddressV1, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces';

const NO_KEYS: ReadonlySet<string> = new Set();

type ColumnMenuInputs = Readonly<{
    refsById: ReadonlyMap<string, WorkspaceRefV1>;
    projectRefByKey: ReadonlyMap<string, ProjectsListModel['groups']['projectGroups'][number]>;
    model: ProjectsListModel;
    creation: ReturnType<typeof useProjectRowCreationActions>;
}>;

/** Pin presentation subscribes per row; user intents resolve the current checkout and handlers. */
function ProjectsColumnRowMenu({ row, inputs }: Readonly<{ row: ProjectsTreeRow; inputs: React.RefObject<ColumnMenuInputs> }>) {
    const id = row.workspaceAddress?.workspaceId;
    const pinned = useIsWorkspaceRefPinned(id);
    const readRef = () => row.workspaceAddress ? inputs.current.refsById.get(JSON.stringify(row.workspaceAddress)) ?? null : null;
    const ref = readRef();
    const project = row.kind === 'project' ? inputs.current.projectRefByKey.get(row.key) ?? null : null;
    if (!ref && !project) return null;
    const actOnRef = (action: (ref: WorkspaceRefV1) => unknown) => {
        const current = readRef();
        if (current) return action(current);
    };
    // The person's grouping (owner 11-08): a Project row moves whole; a checkout moves alone and may separate.
    const group = ref ? inputs.current.projectRefByKey.get(projectWorkspaceRefV1(ref).projectKey) ?? null : project;
    const leaf = row.kind === 'checkout';
    const grouping = group ? {
        targets: () => inputs.current.model.readGroupTargets(group.projectKey.projectKey),
        onGroup: (projectKey: string) => { void inputs.current.model.groupCheckouts(leaf && ref ? [ref] : group.items, projectKey); },
        onSeparate: leaf && ref && group.items.length > 1 ? () => { void inputs.current.model.groupCheckouts([ref], 'self'); } : null,
    } : null;
    return (
        <ProjectsListItemMenu
            workspaceRef={ref}
            project={project?.projectKey}
            grouping={grouping}
            pinAction={ref ? pinned ? 'unpin' : 'pin' : null}
            onTogglePinned={() => { void actOnRef(ref => inputs.current.model.togglePinned(ref.id)); }}
            onRename={() => { void actOnRef(inputs.current.model.renameProject); }}
            onReset={() => { void actOnRef(inputs.current.model.resetProjectName); }}
            onRemove={() => { void actOnRef(inputs.current.model.removeProject); }}
            onNewSession={() => actOnRef(inputs.current.creation.newSession)}
            onSaveAsSource={() => actOnRef(inputs.current.creation.saveSource)}
            onHideProject={project ? () => {
                const current = inputs.current.projectRefByKey.get(row.key);
                if (current) void inputs.current.model.setProjectHidden(current.projectKey, true);
            } : null}
        />
    );
}

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
    const pathname = usePathname();
    const model = useProjectsListModel();
    const creation = useProjectRowCreationActions(model);
    const placed = useColumnDestinations('projects');
    const rowsRetry = useProjectRowsRetry();
    const openId = readOpenProjectId(pathname);

    const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const [collapsedKeys, setCollapsedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
    const refsById = React.useMemo(() => new Map(
        [...model.groups.projectGroups, ...model.groups.hiddenProjectGroups].flatMap((group) => group.items.map((ref) => [JSON.stringify(workspaceAddressFromRefV1(ref)), ref] as const)),
    ), [model.groups.hiddenProjectGroups, model.groups.projectGroups]);
    // The title row's magnifier narrows the tree with the phone page's own filter (F4, owner 1538 #01).
    const [query, setQuery] = React.useState('');
    // Each Project's Environments join its row (pfc-redesign dProject tree): the Project → Environment link.
    const { treeProjects } = model;
    const openEnvironmentId = useProjectsTreeOpenEnvironmentId();
    // What each opened Environment runs (services, databases), read only while it is open.
    const [environmentChildren, publishEnvironmentChildren] = useProjectsTreeEnvironmentChildren();
    const router = useRouter();
    const openHref = React.useCallback((href: string) => { router.push(href as never); }, [router]);
    const projects = React.useMemo(() => filterProjectsTreeByQuery(treeProjects, query), [treeProjects, query]);
    // Structural rows only: a checkout's live facts are read by its Project's own tree section, so a fact
    // change never re-renders this column or the other rows.
    const rows = React.useMemo(
        () => buildProjectsTreeRows({ projects, openRefId: openId, openEnvironmentId, expandedKeys, collapsedKeys, environmentChildren }),
        [collapsedKeys, environmentChildren, expandedKeys, openId, openEnvironmentId, projects],
    );
    const factsSource = useProjectsTreeCheckoutFactsSource(model.checkoutRefs);
    const live = React.useMemo(
        () => ({ source: factsSource, projects, openRefId: openId, openEnvironmentId, expandedKeys, collapsedKeys, environmentChildren }),
        [collapsedKeys, environmentChildren, expandedKeys, factsSource, openId, openEnvironmentId, projects],
    );
    const toggle = React.useCallback((key: string) => {
        const open = rows.find((row) => row.key === key)?.expanded === true;
        const without = (set: ReadonlySet<string>) => { const next = new Set(set); next.delete(key); return next; };
        const withKey = (set: ReadonlySet<string>) => new Set([...set, key]);
        setExpandedKeys((current) => (open ? without(current) : withKey(current)));
        setCollapsedKeys((current) => (open ? withKey(current) : without(current)));
    }, [rows]);
    const openRef = model.openTreeRef;
    const hrefForRef = React.useCallback((refId: string, address?: WorkspaceAddressV1) => address
        ? `/projects/${encodeURIComponent(refId)}?serverId=${encodeURIComponent(address.serverId)}` : null, []);
    const projectRefByKey = React.useMemo(() => new Map(
        [...model.groups.projectGroups, ...model.groups.hiddenProjectGroups].flatMap((group) => group.items[0] ? [[group.projectKey.projectKey, group] as const] : []),
    ), [model.groups.hiddenProjectGroups, model.groups.projectGroups]);
    const menuInputs = React.useRef<ColumnMenuInputs>({ refsById, projectRefByKey, model, creation });
    menuInputs.current = { refsById, projectRefByKey, model, creation };
    const renderRowMenu = React.useCallback((row: ProjectsTreeRow) => <ProjectsColumnRowMenu row={row} inputs={menuInputs} />, []);
    // Saved-not-open Sources after the tree and the "+" composition: one owner for every Projects entrance.
    const { addSources, saved, cloneRepository } = model;
    const openNewApp = useOpenNewApp(cloneRepository);
    const [hiddenOpen, setHiddenOpen] = React.useState(false);
    const { hiddenItems, showHiddenProject } = model;
    const hidden = React.useMemo(() => ({
        items: hiddenItems,
        open: hiddenOpen,
        onToggle: () => setHiddenOpen((open) => !open),
        onShow: showHiddenProject,
    }), [hiddenItems, hiddenOpen, showHiddenProject]);

    const columnHead = (
        <>
            <CollectionRows>
                {placed.destinations.map((destination) => (
                    <CollectionNavigationRow
                        rowRole="item"
                        key={destination.id}
                        href={destination.activation === 'navigate' ? destination.routePath : null}
                        testID={destinationRowTestId(destination)}
                        title={destination.title}
                        icon={<Icon name={destination.icon} />}
                        selected={destination.id === placed.currentId}
                        onPress={() => placed.activate(destination)}
                    />
                ))}
            </CollectionRows>
            {/* Rows not confirmed yet: quiet rows while they load, one line with Retry when the read failed. No Projects
                yet: the page beside the column says so with its Add (F4), so the column stays quiet. */}
            {model.rowsUnconfirmed && isProjectRowsPending(model.rowsUnconfirmed) ? (
                <ProjectsTreeSkeletonRows testID="projects-column:loading" rows={3} />
            ) : model.rowsUnconfirmed ? (
                <View style={collectionListStyles.stateLine}>
                    <ProjectOpenResolutionCard
                        testID="projects-column:rows"
                        issue={model.rowsUnconfirmed}
                        line
                        onChoose={() => {}}
                        onRetry={rowsRetry}
                    />
                </View>
            ) : model.staleRows ? (
                // A failed refresh over the rows below: they stay at full strength, labeled as of the last read.
                <View style={collectionListStyles.stateLine}>
                    <ProjectRowsStaleLine testID="projects-column:stale" asOf={model.staleRows.asOf} />
                </View>
            ) : null}
            {query.trim().length > 0 && rows.length === 0 && !model.noProjects ? (
                <EmptyState testID="projects-column:no-matches" layout="line" title={t('common.noMatches')} />
            ) : null}
        </>
    );

    return (
        <View testID="projects-column" style={styles.column}>
            <ProjectsTreeEnvironmentReads projects={projects} expandedKeys={expandedKeys} collapsedKeys={collapsedKeys}
                onChildren={publishEnvironmentChildren} />
            <CollectionList
                testID="projects-column:list"
                surface="plane"
                title={t('tabs.projects')}
                // A count speaks only once there is something to count (lab `treeCol`: no "0").
                count={model.projectCount > 0 ? model.projectCount : undefined}
                search={{
                    testID: 'projects-column:search',
                    value: query,
                    onChangeText: setQuery,
                    placeholder: t('projects.searchPlaceholder'),
                }}
                // What just happened to a row (Hide · Undo, an approval, an ambiguous open) is pinned under
                // the rows, so it is in view wherever the tree is scrolled (lab p-projects HIDE).
                footer={(
                    <>
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
                    </>
                )}
                headerAction={(
                    <ProjectsAddMenu
                        testID="projects-column:add"
                        machines={model.addFirstMachines}
                        onAdd={model.addProjectToMachine}
                        remote={model.addRemote}
                        onClone={cloneRepository}
                        onNewApp={openNewApp}
                        sources={addSources}
                        fromSessions={model.fromSessions}
                    />
                )}
                // The column scrolls as one windowed list: its entries and state line lead the Project rows,
                // and only the rows near the viewport are built (a Home can hold hundreds of Projects).
                scrollContent={(
                    <ProjectsTreeList
                        testID="projects-column:tree"
                        header={columnHead}
                        rows={rows}
                        live={live}
                        onToggle={toggle}
                        onOpenRef={openRef}
                        onOpenHref={openHref}
                        hrefForRef={hrefForRef}
                        renderRowMenu={renderRowMenu}
                        hidden={hidden}
                        saved={saved}
                    />
                )}
            />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    column: {
        flex: 1,
        minHeight: 0,
    },
}));
