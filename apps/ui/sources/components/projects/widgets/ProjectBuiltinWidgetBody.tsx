import * as React from 'react';
import { View } from 'react-native';
import type { BuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { buildProjectCheckoutOpenRoute } from '@/components/projects/activation/projectOpenRoute';
import { useNavigateToProjectOpen } from '@/components/projects/activation/projectOpenPresentation';
import { ProjectScriptsBody } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { buildProjectRouteHref, readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { WorkspaceCodeBrowserView, type WorkspaceCodeLocation } from '@/components/projects/files/code/WorkspaceCodeBrowserView';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { useWorkspaceRepositoryDirectoryRevision } from '@/hooks/workspaces/files/useWorkspaceRepositoryDirectoryRevision';
import type { SessionPaneUrlDetailsTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { WorkspaceWorktreeListSection } from '@/components/workspaces/scm/worktrees/WorkspaceWorktreeListSection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useAllMachines, useWorkspaceRefs, useServerScopedMachine, useWorkspaceScmSnapshot } from '@/sync/domains/state/storage';
import { sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { warmWorkspaceRepositoryDirectoryCache } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { readProjectReadmePath } from './projectReadmePath';
import { WorkspaceLocalChangesBody } from '@/components/projects/scm/WorkspaceLocalChangesBody';
import { activeReviewFileKeyForWorkspace, requestActiveReviewFileForComparison } from '@/components/workspaces/scm/review/activeReviewFile';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type Props = Readonly<{ id: BuiltinWidgetIdV1; workspace: WorkspaceAddressV1; checkout: WorkspaceRefV1; testID: string }>;

/** Native Project bodies consume only the generic binder's admitted exact checkout. */
export function ProjectBuiltinWidgetBody(props: Props): React.ReactElement {
    if (props.id === 'project_about') return <AboutBody {...props} />;
    if (props.id === 'project_code') return <CodeBody {...props} />;
    if (props.id === 'project_readme') return <ReadmeBody {...props} />;
    if (props.id === 'project_checkouts') return <CheckoutsBody {...props} />;
    if (props.id === 'project_changes') return <ChangesBody {...props} />;
    if (props.id === 'project_scripts') return <ProjectScriptsBody workspace={props.workspace} presentation="widget" testID={props.testID} />;
    // The stable Project roster needs its live UI producer; legacy machine/path
    // Session groups cannot supply it.
    return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: `widget_${props.id}_producer_unavailable` }} testID={props.testID} />;
}

function useScope(workspace: WorkspaceAddressV1): WorkspaceScopeBase {
    return React.useMemo(() => ({ serverId: workspace.serverId, machineId: workspace.machineId, rootPath: workspace.rootPath }),
        [workspace.serverId, workspace.machineId, workspace.rootPath]);
}

function useProjectNavigation(workspace: WorkspaceAddressV1, checkout: WorkspaceRefV1) {
    const router = useRouter();
    const routeParams = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const currentRoute = resolveProjectCockpitRouteFromPathname(usePathname());
    const currentCheckout = useWorkspaceRefById(currentRoute?.workspaceRefId ?? '', readProjectRouteStringParam(routeParams.serverId));
    const admittedRouteParams = currentCheckout && sameWorkspaceProject(currentCheckout, checkout) ? routeParams : undefined;
    const storedCheckout = useWorkspaceRefById(workspace.workspaceId, workspace.serverId);
    const scope = useScope(workspace);
    const snapshot = useWorkspaceScmSnapshot(scope);
    const defaultRootPath = storedCheckout?.rootPath ?? workspace.rootPath;
    const href = React.useCallback((segment: 'overview' | 'code' | 'changes', filePath?: string, rootPath = workspace.rootPath, worktreeId?: string | null, details?: SessionPaneUrlDetailsTarget) => buildProjectRouteHref({
        workspaceRefId: workspace.workspaceId, serverId: workspace.serverId, segment,
        routeParams: admittedRouteParams,
        activeRootPath: rootPath, defaultRootPath,
        activeWorktreeId: worktreeId ?? findVisibleRepoWorktreeByPath(snapshot?.repo.worktrees ?? [], rootPath)?.id,
        ...(filePath ? { initialResource: { kind: 'file' as const, path: filePath } } : {}),
        ...(details ? { details } : {}),
    }), [workspace.workspaceId, workspace.serverId, workspace.rootPath, defaultRootPath, snapshot?.repo.worktrees, admittedRouteParams]);
    const openFile = React.useCallback((path: string) => router.push(href('code', path) as Parameters<typeof router.push>[0]), [href, router]);
    return { href, openFile, router };
}

function AboutBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const machine = useServerScopedMachine(scope.serverId, scope.machineId);
    const { snapshot } = useWorkspaceScmSnapshotController(scope);
    return <View testID={props.testID}><ItemGroup>
        {props.checkout.repositoryIdentity ? <Item title={props.checkout.repositoryIdentity.repository}
            subtitle={props.checkout.repositoryIdentity.deployment} mode="info" /> : null}
        <Item title={t('projects.detail.fields.machine')} detail={getMachineDisplayName(machine) ?? scope.machineId} mode="info" />
        <Item title={t('projects.detail.fields.path')} detail={scope.rootPath} copy={scope.rootPath} mode="info" />
        {snapshot?.branch.head ? <Item title={t('projects.widgets.branch')} detail={snapshot.branch.head} mode="info" /> : null}
    </ItemGroup></View>;
}

function CodeBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const navigation = useProjectNavigation(props.workspace, props.checkout);
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspace.workspaceId, props.workspace.serverId));
    const browser = useRepositoryTreeBrowserState(tryBuildWorkspaceCacheKey(scope) ?? '');
    const location = browser.location.kind === 'folder' ? browser.location
        : { path: browser.location.path.slice(0, Math.max(0, browser.location.path.lastIndexOf('/'))), kind: 'folder' as const };
    const openCode = (target: WorkspaceCodeLocation) => target.kind === 'file' ? navigation.openFile(target.path)
        : navigation.router.push(navigation.href('code') as Parameters<typeof navigation.router.push>[0]);
    return <WorkspaceCodeBrowserView testID={props.testID} scope={scope} paneScopeId={scopeId}
        rootLabel={resolveWorkspaceRefDisplayName(props.checkout)} presentation="widget" location={location}
        onNavigate={target => target.kind === 'folder' ? browser.setLocation(target) : navigation.openFile(target.path)}
        onOpenInCode={openCode} onOpenFilePinned={navigation.openFile} fileHref={path => navigation.href('code', path)} />;
}

function ReadmeBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspace.workspaceId, props.workspace.serverId));
    const key = tryBuildWorkspaceCacheKey(scope);
    const directoryRevision = useWorkspaceRepositoryDirectoryRevision(key);
    const [read, setRead] = React.useState<Readonly<{ key: string | null; kind: 'ready'; path: string | null }> | Readonly<{ key: string | null; kind: 'error' }> | null>(null);
    const [refresh, setRefresh] = React.useState(0);
    React.useEffect(() => {
        let current = true;
        void warmWorkspaceRepositoryDirectoryCache({ scope, directoryPath: '' }).then(result => {
            if (!current) return;
            setRead(result.ok ? { key, kind: 'ready', path: readProjectReadmePath(result.entries) } : { key, kind: 'error' });
        }).catch(() => { if (current) setRead({ key, kind: 'error' }); });
        return () => { current = false; };
    }, [scope, key, refresh, directoryRevision]);
    if (!read || read.key !== key) return <UnavailableInstalledWidget unresolved={{ state: 'loading', reasonCode: 'widget_project_readme_loading' }} testID={props.testID} />;
    if (read.kind === 'error') return <View testID={props.testID}>
        <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_project_readme_unavailable' }} testID={props.testID} />
        <Item title={t('common.retry')} onPress={() => setRefresh(value => value + 1)} />
    </View>;
    if (!read.path) return <Text testID={props.testID}>{t('projects.widgets.readmeMissing')}</Text>;
    return <View testID={props.testID}><WorkspaceFileDetailsView scopeId={scopeId} scope={scope} filePath={read.path} presentation="panel" /></View>;
}

function CheckoutsBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const { snapshot, error } = useWorkspaceScmSnapshotController(scope);
    const navigation = useProjectNavigation(props.workspace, props.checkout);
    const navigateToOpen = useNavigateToProjectOpen();
    const checkout = props.checkout;
    const refs = useWorkspaceRefs();
    const machines = useAllMachines();
    const openProject = useOpenProject();
    const elsewhere = refs.filter(ref => ref.id !== checkout.id && ref.machineId !== checkout.machineId
        && sameWorkspaceProject(ref, checkout));
    return <View testID={props.testID}>{snapshot ? <WorkspaceWorktreeListSection worktrees={snapshot.repo.worktrees ?? []} selectedRootPath={scope.rootPath}
        onSelectRootPath={path => navigation.router.push(navigation.href('overview', undefined, path, findVisibleRepoWorktreeByPath(snapshot.repo.worktrees ?? [], path)?.id) as Parameters<typeof navigation.router.push>[0])} />
        : <UnavailableInstalledWidget unresolved={{ state: error ? 'unavailable' : 'loading', reasonCode: 'widget_project_checkouts_unavailable' }} testID={`${props.testID}.worktrees`} />}
        {elsewhere.length > 0 ? <ItemGroup title={t('projects.checkouts.otherMachines')}>
            {elsewhere.map(ref => <Item key={`${ref.serverId}:${ref.id}`} testID={`${props.testID}.checkout:${ref.id}`}
                title={resolveWorkspaceRefDisplayName(ref)} subtitle={`${getMachineDisplayName(machines.find(machine => machine.id === ref.machineId) ?? null) ?? ref.machineId} · ${ref.rootPath}`}
                onPress={() => openProject(ref.id, { serverId: ref.serverId })} />)}
        </ItemGroup> : null}
        <Item title={t('projects.checkouts.openElsewhere')} testID={`${props.testID}.open-elsewhere`} onPress={() => navigateToOpen(
            buildProjectCheckoutOpenRoute(props.workspace, snapshot?.branch.head))} />
    </View>;
}

function ChangesBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const navigation = useProjectNavigation(props.workspace, props.checkout);
    const lifetime = captureActiveServerAccountScopeLifetime();
    const scopeKey = tryBuildWorkspaceCacheKey(scope);
    const currentScopeKey = React.useRef(scopeKey);
    currentScopeKey.current = scopeKey;
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const isCurrent = () => Boolean(lifetime?.isCurrent()) && currentScopeKey.current === scopeKey;
    const openReview = (path?: string, walkthrough = false) => {
        if (!mounted.current || !isCurrent() || !lifetime || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, scope.serverId)) return;
        const href = navigation.href('changes', undefined, scope.rootPath, undefined,
            { kind: 'scmReview', comparison: { kind: 'workingTree' }, view: walkthrough ? 'walkthrough' : 'files' });
        navigation.router.push(href as Parameters<typeof navigation.router.push>[0]);
        // The source widget unmounts during this intended route promotion; changing its scope still retires the request.
        if (path) requestActiveReviewFileForComparison(activeReviewFileKeyForWorkspace(scope), path, { kind: 'workingTree' }, isCurrent);
    };
    return <WorkspaceLocalChangesBody key={tryBuildWorkspaceCacheKey(scope)} scope={scope} onOpenReview={path => openReview(path)}
        onWalkThrough={() => openReview(undefined, true)} testID={props.testID} />;
}
