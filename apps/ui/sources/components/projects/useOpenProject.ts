import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { captureMountedWorkspaceAction, resolveWorkspaceUiActionOutcome } from '@/components/appShell/workspace/workspaceActionRuntime';

import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { isMobileWorkspaceCockpitEnabled } from '@/components/workspaceCockpit/mobileWorkspaceExperience';
import { storage, useWorkspaceRefs, useSetting } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { getDeviceType } from '@/utils/platform/responsive';

import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { buildProjectRouteHref, resolveProjectOpenHref, type ProjectAttachedDashboardSelection } from './detail/projectRouteState';
import { createProjectCommitDetailsTab } from './detail/projectDetailsTabBuilders';
import { useWorkspaceFileOpener, type WorkspaceFileOpenOptions } from '@/components/workspaces/files/useWorkspaceFileOpener';
import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { FileFindSeed as FindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { resolveProjectMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import { projectLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { readProjectSelectionUiState } from '@/sync/domains/state/projectSelectionUiState';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export type OpenProjectOptions = Readonly<{
    serverId?: string;
    workspaceAddress?: WorkspaceAddressV1;
    activeRootPath?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    /** Open on one of the person's own dashboards: its layout id, or `null` for the default. */
    layoutId?: string | null;
    initialResource?: Readonly<{ kind: 'file'; path: string; anchor?: FileTargetAnchor; anchorSource?: ReviewCommentSource; find?: FindSeed }> | Readonly<{ kind: 'commit'; sha: string }>;
}>;

/** Opens an existing project through the shared persisted surface/worktree policy. */
export type OpenProject = ((workspaceRefId: string, options?: OpenProjectOptions) => Promise<boolean | null>) & Readonly<{
    resolution: Exclude<WorkspaceRefResolutionV1, { kind: 'resolved' }> | null;
    dismissResolution(): void;
}>;

export function useOpenProject(): OpenProject {
    const router = useRouter();
    const { open: openFile } = useWorkspaceFileOpener();
    const paneSubscription = React.useContext(AppPaneContext);
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const workspaceRefs = useWorkspaceRefs();
    const [resolutionIssue, setResolutionIssue] = React.useState<OpenProject['resolution']>(null);
    const issueRef = React.useRef(resolutionIssue);
    const publishIssue = React.useCallback((issue: OpenProject['resolution']) => {
        issueRef.current = issue;
        setResolutionIssue(issue);
    }, []);

    const open = React.useCallback(async (workspaceRefId: string, options?: OpenProjectOptions) => {
        const deviceType = getDeviceType();
        const normalizedId = workspaceRefId.trim();
        if (options?.workspaceAddress && options.workspaceAddress.workspaceId !== normalizedId) {
            publishIssue({ kind: 'invalid', reason: 'workspace_address_id_mismatch' });
            return false;
        }
        // Accepted row refresh can settle before React updates its subscription.
        const refs = options?.workspaceAddress ? readProjectWorkspaceRefs(storage.getState())
            : Array.isArray(workspaceRefs) ? workspaceRefs : [];
        const resolution = options?.workspaceAddress
            ? resolveWorkspaceRefByAddress(refs, options.workspaceAddress)
            : resolveWorkspaceRefById(refs, normalizedId, options?.serverId);
        if (resolution.kind !== 'resolved') { publishIssue(resolution); return false; }
        publishIssue(null);
        const workspaceRef = resolution.ref;
        const pageAuthority = captureActiveServerAccountScopeLifetime();
        const pagePreferenceKey = resolveProjectMobileSurfaceStorageKey({ workspaceRefs: refs, workspaceRefId: workspaceRef.id,
            targetServerId: workspaceRef.serverId, activeScope: pageAuthority?.scope, activeServerId: pageAuthority?.scope.serverId });
        const preferenceKeys = resolveProjectSelectionPreferenceKeys(refs, workspaceRef);
        const { activeRootPath: persistedActiveRootPath, worktreeId: persistedWorktreeId } = readProjectSelectionUiState(preferenceKeys);
        const scopeId = buildProjectPaneScopeId(workspaceRef.id, workspaceRef.serverId);
        const activeRootPath = options?.activeRootPath?.trim()
            || persistedActiveRootPath
            || workspaceRef.rootPath;
        const activeWorktreeId = activeRootPath === workspaceRef.rootPath
            ? null
            : activeRootPath === persistedActiveRootPath
            ? persistedWorktreeId
            : null;
        if (options?.attachedDashboard || options?.layoutId !== undefined) {
            return await openHref(buildProjectRouteHref({ workspaceRefId: workspaceRef.id, serverId: workspaceRef.serverId,
                segment: 'overview', activeRootPath, defaultRootPath: workspaceRef.rootPath, activeWorktreeId,
                ...(options.attachedDashboard ? { attachedDashboard: options.attachedDashboard } : { layoutId: options.layoutId })}));
        }
        if (options?.initialResource) {
            const resource = options.initialResource;
            let find: WorkspaceFileOpenOptions['find'];
            if (resource.kind === 'file' && resource.find) {
                if (resource.path !== resource.find.target.path) return false;
                find = { query: resource.find.query, options: resource.find.options, target: {
                    kind: 'project-file', workspaceRefId: workspaceRef.id,
                    serverId: resolveServerProfileScopeIdForIdentifier(workspaceRef.serverId),
                    machineId: workspaceRef.machineId, rootPath: activeRootPath, path: resource.path,
                    ...(resource.find.target.anchor ? { anchor: resource.find.target.anchor } : {}),
                } };
            }
            if (resource.kind === 'file') {
                return openFile({ kind: 'project', workspaceRefId: workspaceRef.id, serverId: workspaceRef.serverId,
                    machineId: workspaceRef.machineId, rootPath: activeRootPath, path: resource.path }, {
                    intent: 'pinned', ...(resource.anchor ? { anchor: resource.anchor } : {}),
                    ...(resource.anchorSource ? { anchorSource: resource.anchorSource } : {}), ...(find ? { find } : {}),
                });
            }
            if (!createProjectCommitDetailsTab(resource.sha)) return false;
            return await openHref(buildProjectRouteHref({
                    workspaceRefId: workspaceRef.id,
                    serverId: workspaceRef.serverId,
                    segment: 'changes',
                    activeRootPath,
                    defaultRootPath: workspaceRef.rootPath,
                    activeWorktreeId,
                    initialResource: resource,
                    ...(deviceType === 'phone'
                        ? { sourceSurface: 'git' as const }
                        : {}),
                }), find);
        }
        return await openHref(resolveProjectOpenHref({
            workspaceRef,
            deviceType,
            cockpitEnabled: isMobileWorkspaceCockpitEnabled({ deviceType, mobileWorkspaceExperience }),
            rememberedRightTabId: paneSubscription?.getSnapshot().state.scopes[scopeId]?.right?.activeTabId,
            persistedMobileSurface: pagePreferenceKey ? projectLastMobileSurfaceState.read(pagePreferenceKey) ?? null : null,
            persistedActiveRootPath: activeRootPath,
            persistedWorktreeId: activeWorktreeId,
        }));

        async function openHref(href: string, find?: unknown): Promise<boolean | null> {
            const execute = captureMountedWorkspaceAction();
            if (!execute) {
                if (find) return false;
                router.push(href as never);
                return true;
            }
            const result = await execute({ actionId: 'workspace.tabs.open', input: { href, ...(find ? { find } : {}) } });
            return resolveWorkspaceUiActionOutcome(result);
        }
    }, [mobileWorkspaceExperience, openFile, paneSubscription, publishIssue, router, workspaceRefs]);
    return React.useMemo(() => Object.defineProperties(open, {
        resolution: { configurable: true, get: () => issueRef.current },
        dismissResolution: { configurable: true, value: () => publishIssue(null) },
    }) as OpenProject, [open, publishIssue]);
}
