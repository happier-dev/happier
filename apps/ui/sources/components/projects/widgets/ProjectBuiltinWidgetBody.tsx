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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { filterVisibleRepoWorktreeRows } from '@/components/workspaces/scm/worktrees/filterVisibleRepoWorktreeRows';
import { sortRepoWorktreeRows } from '@/components/workspaces/scm/worktrees/sortRepoWorktreeRows';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useActiveServerAccountScope, useAllMachines, useWorkspaceRefs, useWorkspaceScmSnapshot } from '@/sync/domains/state/storage';
import { sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { warmWorkspaceRepositoryDirectoryCache } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { readProjectReadmePath } from './projectReadmePath';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { readSourceTeamId } from '@/components/projects/sources/projectSourceGroups';
import { formatProjectSourceAddress } from '@/components/projects/sources/projectSourceAddress';
import { useProjectsTreeCheckoutFacts } from '@/components/projects/useProjectsTreeCheckoutFacts';
import { projectsTreeCheckoutKey } from '@/components/projects/projectsTreeRows';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { WorkspaceLocalChangesBody } from '@/components/projects/scm/WorkspaceLocalChangesBody';
import { activeReviewFileKeyForWorkspace, requestActiveReviewFileForComparison } from '@/components/workspaces/scm/review/activeReviewFile';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
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
    const href = React.useCallback((segment: 'overview' | 'code' | 'changes', filePath?: string, rootPath = workspace.rootPath, worktreeId?: string | null, details?: SessionPaneUrlDetailsTarget, codeLocation?: WorkspaceCodeLocation) => buildProjectRouteHref({
        workspaceRefId: workspace.workspaceId, serverId: workspace.serverId, segment,
        routeParams: admittedRouteParams,
        activeRootPath: rootPath, defaultRootPath,
        activeWorktreeId: worktreeId ?? findVisibleRepoWorktreeByPath(snapshot?.repo.worktrees ?? [], rootPath)?.id,
        ...(filePath !== undefined ? (segment === 'code'
            ? { initialResource: null, codeLocation: { kind: 'file' as const, path: filePath } }
            : { initialResource: { kind: 'file' as const, path: filePath } }) : {}),
        ...(codeLocation ? { initialResource: null, codeLocation } : {}),
        ...(details ? { details } : {}),
    }), [workspace.workspaceId, workspace.serverId, workspace.rootPath, defaultRootPath, snapshot?.repo.worktrees, admittedRouteParams]);
    const openFile = React.useCallback((path: string) => router.push(href('code', path) as Parameters<typeof router.push>[0]), [href, router]);
    return { href, openFile, router };
}

/**
 * About (plan 12, lab p-overview HOME `aboutW`): what this Project is, in the facts that are really
 * known — its repository, its Source's default branch and who it is shared with. The checkout's own
 * machine, path and branch are the header chip's, not repeated here.
 */
function AboutBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const viewer = useActiveServerAccountScope();
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer?.serverId, viewer?.accountId]);
    const admitted = lifetime?.isCurrent() && selectActiveServerAccountScopeForServer(viewer, scope.serverId) ? lifetime : null;
    const source = useProjectSource(admitted, props.checkout.source?.sourceId ?? null).source?.source ?? null;
    const teamId = source ? readSourceTeamId(source) : null;
    const teamServerIds = React.useMemo(() => (teamId ? [scope.serverId] : []), [scope.serverId, teamId]);
    const teams = useTeamsDirectory({ serverIds: teamServerIds, enabled: teamId != null });
    const teamName = teamId ? teams.rows.find(row => row.team.id === teamId)?.team.name ?? null : null;
    const repository = props.checkout.repositoryIdentity?.repository ?? (source ? formatProjectSourceAddress(source.repository) : null);
    const snapshot = useWorkspaceScmSnapshot(scope);
    const defaultBranch = source?.defaultRef ?? snapshot?.repo.defaultBranch ?? null;
    return <View testID={props.testID}>
        {repository
            ? <WidgetGlanceRow testID={`${props.testID}.repository`} variant="fact" mark="book-bookmark" title={repository} />
            : <WidgetGlanceRow testID={`${props.testID}.folder`} variant="fact" mark="folder" title={scope.rootPath} mono />}
        {defaultBranch ? <WidgetGlanceRow testID={`${props.testID}.default-branch`} variant="fact" mark="git-branch"
            title={t('projects.open.defaultRef', { ref: defaultBranch })} /> : null}
        {teamName ? <WidgetGlanceRow testID={`${props.testID}.team`} variant="fact" mark="users"
            title={t('projects.sources.sharedWithTeam', { team: teamName })} /> : null}
    </View>;
}

function CodeBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const navigation = useProjectNavigation(props.workspace, props.checkout);
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspace.workspaceId, props.workspace.serverId));
    const browser = useRepositoryTreeBrowserState(tryBuildWorkspaceCacheKey(scope) ?? '');
    const location = browser.location.kind === 'folder' ? browser.location
        : { path: browser.location.path.slice(0, Math.max(0, browser.location.path.lastIndexOf('/'))), kind: 'folder' as const };
    const openCode = (target: WorkspaceCodeLocation) => target.kind === 'file' ? navigation.openFile(target.path)
        : navigation.router.push(navigation.href('code', undefined, props.workspace.rootPath, undefined, undefined, target) as Parameters<typeof navigation.router.push>[0]);
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
    // One state, one message, its next action beside it (the same line states as Local changes).
    if (read.kind === 'error') return <SurfaceStateCard testID={props.testID} size="line" kind="error"
        title={t('projects.code.readUnavailable')} action={{ label: t('common.retry'), onPress: () => setRefresh(value => value + 1) }} />;
    if (!read.path) return <SurfaceStateCard testID={props.testID} size="line" kind="empty" title={t('projects.widgets.readmeMissing')} />;
    return <View testID={props.testID}><WorkspaceFileDetailsView scopeId={scopeId} scope={scope} filePath={read.path} presentation="panel" /></View>;
}

/**
 * Checkouts (plan 12, lab p-overview HOME `checkoutsW`): one list of where this Project is checked
 * out — this checkout, this repository's other worktrees, and its accepted checkouts on other
 * machines — each with its machine and what is happening there. The status is the Projects tree's
 * own summary (`projectsTreeCheckoutFacts`), so the tree and the widget never disagree.
 */
function CheckoutsBody(props: Props): React.ReactElement {
    const scope = useScope(props.workspace);
    const { snapshot } = useWorkspaceScmSnapshotController(scope);
    const navigation = useProjectNavigation(props.workspace, props.checkout);
    const navigateToOpen = useNavigateToProjectOpen();
    const checkout = props.checkout;
    const refs = useWorkspaceRefs();
    const machines = useAllMachines();
    const openProject = useOpenProject();
    const projectRefs = React.useMemo(() => refs.filter(ref => sameWorkspaceProject(ref, checkout)),
        // The Project is the checkout's stored identity, not the prop object's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [refs, checkout.id, checkout.serverId, checkout.machineId, checkout.rootPath, checkout.projectKey]);
    const facts = useProjectsTreeCheckoutFacts(projectRefs);
    const machineName = (machineId: string) => getMachineDisplayName(machines.find(machine => machine.id === machineId) ?? null) ?? machineId;
    const refAt = (machineId: string, rootPath: string) => projectRefs.find(ref => ref.machineId === machineId
        && normalizeWorkspaceRootPath(ref.rootPath) === normalizeWorkspaceRootPath(rootPath)) ?? null;
    const status = (ref: WorkspaceRefV1 | null) => (ref
        ? facts.get(projectsTreeCheckoutKey({ refId: ref.id, workspaceAddress: workspaceAddressFromRefV1(ref) })) ?? null : null);
    const fact = (machineId: string, ref: WorkspaceRefV1 | null) => {
        const attention = status(ref)?.attention ?? null;
        return {
            fact: [machineName(machineId), attention === 'needs-you' ? t('projects.checkouts.needsYou')
                : attention === 'working' ? t('projects.checkouts.working') : null].filter(Boolean).join(' · '),
            factTone: attention === 'needs-you' ? 'attention' as const : 'quiet' as const,
        };
    };
    const here = refAt(scope.machineId, scope.rootPath);
    const worktrees = sortRepoWorktreeRows(filterVisibleRepoWorktreeRows(snapshot?.repo.worktrees ?? []))
        .filter(worktree => normalizeWorkspaceRootPath(worktree.path) !== normalizeWorkspaceRootPath(scope.rootPath));
    const listed = new Set([here, ...worktrees.map(worktree => refAt(scope.machineId, worktree.path))]);
    const others = projectRefs.filter(ref => !listed.has(ref));
    return <View testID={props.testID}>
        <WidgetGlanceRow testID={`${props.testID}.here`} mark="desktop" tag={t('projects.checkouts.here')}
            title={snapshot?.branch.head ?? status(here)?.branch ?? resolveWorkspaceRefDisplayName(checkout)}
            {...fact(scope.machineId, here)} />
        {worktrees.map(worktree => <WidgetGlanceRow key={worktree.path} testID={`${props.testID}.worktree:${worktree.id ?? worktree.path}`} mark="desktop"
            title={worktree.branch ?? worktree.path} {...fact(scope.machineId, refAt(scope.machineId, worktree.path))}
            onPress={() => navigation.router.push(navigation.href('overview', undefined, worktree.path, worktree.id) as Parameters<typeof navigation.router.push>[0])} />)}
        {others.map(ref => <WidgetGlanceRow key={`${ref.serverId}:${ref.machineId}:${ref.id}:${ref.rootPath}`} testID={`${props.testID}.checkout:${ref.id}`} mark="desktop"
            title={status(ref)?.branch ?? resolveWorkspaceRefDisplayName(ref)} {...fact(ref.machineId, ref)}
            onPress={() => openProject(ref.id, { serverId: ref.serverId })} />)}
        <WidgetGlanceRow testID={`${props.testID}.open-elsewhere`} variant="fact" mark="plus" title={t('projects.checkouts.openElsewhere')}
            onPress={() => navigateToOpen(buildProjectCheckoutOpenRoute(props.workspace, snapshot?.branch.head))} />
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
