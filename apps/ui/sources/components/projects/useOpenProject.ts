import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { storage, useWorkspaceRefs, useLocalSetting } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { useDeviceType } from '@/utils/platform/responsive';

import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { buildProjectRouteHref, resolveProjectOpenHref } from './detail/projectRouteState';
import { createProjectCommitDetailsTab, createProjectFileDetailsTab } from './detail/projectDetailsTabBuilders';
import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { FileFindSeed as FindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys } from '@/sync/domains/settings/projectSelectionPersistence';
import { readRealmQualifiedMobileSurface, resolveProjectMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export type OpenProjectOptions = Readonly<{
    serverId?: string;
    workspaceAddress?: WorkspaceAddressV1;
    activeRootPath?: string;
    initialResource?: Readonly<{ kind: 'file'; path: string; anchor?: FileTargetAnchor; anchorSource?: ReviewCommentSource; find?: FindSeed }> | Readonly<{ kind: 'commit'; sha: string }>;
}>;

/** Opens an existing project through the shared persisted surface/worktree policy. */
export type OpenProject = ((workspaceRefId: string, options?: OpenProjectOptions) => boolean) & Readonly<{
    resolution: Exclude<WorkspaceRefResolutionV1, { kind: 'resolved' }> | null;
    dismissResolution(): void;
}>;

export function useOpenProject(): OpenProject {
    const router = useRouter();
    const deviceType = useDeviceType();
    const paneContext = useOptionalAppPaneContext();
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const workspaceRefs = useWorkspaceRefs();
    const lastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [resolutionIssue, setResolutionIssue] = React.useState<OpenProject['resolution']>(null);
    const issueRef = React.useRef(resolutionIssue);
    const publishIssue = React.useCallback((issue: OpenProject['resolution']) => {
        issueRef.current = issue;
        setResolutionIssue(issue);
    }, []);

    const open = React.useCallback((workspaceRefId: string, options?: OpenProjectOptions) => {
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
        const persistedActiveRootPath = readProjectSelectionPreference(lastActiveRootPathByWorkspaceRefId, preferenceKeys);
        const persistedWorktreeId = readProjectSelectionPreference(lastActiveWorktreeIdByWorkspaceRefId, preferenceKeys);
        const scopeId = buildProjectPaneScopeId(workspaceRef.id, workspaceRef.serverId);
        const activeRootPath = options?.activeRootPath?.trim()
            || persistedActiveRootPath
            || workspaceRef.rootPath;
        const activeWorktreeId = activeRootPath === workspaceRef.rootPath
            ? null
            : activeRootPath === persistedActiveRootPath
            ? persistedWorktreeId
            : null;
        if (options?.initialResource) {
            const tab = options.initialResource.kind === 'file'
                ? createProjectFileDetailsTab(options.initialResource.path, options.initialResource.anchor, options.initialResource.anchorSource)
                : createProjectCommitDetailsTab(options.initialResource.sha);
            if (!tab) return false;
            let cancelSeed: (() => void) | undefined;
            const resource = options.initialResource;
            if (resource.kind === 'file' && resource.find) {
                const handoff = paneContext?.fileFindSeedHandoff;
                if (!handoff || resource.path !== resource.find.target.path) return false;
                const destination = { host: 'project' as const, id: workspaceRef.id, path: resource.path,
                    scope: { serverId: resolveServerProfileScopeIdForIdentifier(workspaceRef.serverId), machineId: workspaceRef.machineId, rootPath: activeRootPath } };
                // Search already staged the exact credential-bound seed; do not replace its authority.
                if (handoff.peekCurrent(destination) !== resource.find) {
                    const authority = captureActiveServerAccountScopeLifetime();
                    if (!authority?.isCurrent() || authority.scope.serverId !== destination.scope.serverId) return false;
                    cancelSeed = handoff.stage({ ...destination, accountId: authority.scope.accountId }, resource.find, authority);
                }
            }
            try {
                router.push(buildProjectRouteHref({
                    workspaceRefId: workspaceRef.id,
                    serverId: workspaceRef.serverId,
                    segment: options.initialResource.kind === 'file' ? 'code' : 'changes',
                    activeRootPath,
                    defaultRootPath: workspaceRef.rootPath,
                    activeWorktreeId,
                    initialResource: options.initialResource,
                    ...(deviceType === 'phone'
                        ? { sourceSurface: options.initialResource.kind === 'file' ? 'browse' as const : 'git' as const }
                        : {}),
                }) as never);
            } catch (error) {
                cancelSeed?.();
                throw error;
            }
            return true;
        }
        router.push(resolveProjectOpenHref({
            workspaceRef,
            deviceType,
            cockpitEnabled,
            rememberedRightTabId: paneContext?.state.scopes[scopeId]?.right?.activeTabId,
            persistedMobileSurface: readRealmQualifiedMobileSurface(lastMobileSurfaceByWorkspaceRefId, pagePreferenceKey),
            persistedActiveRootPath: activeRootPath,
            persistedWorktreeId: activeWorktreeId,
        }) as never);
        return true;
    }, [cockpitEnabled, deviceType, lastActiveRootPathByWorkspaceRefId, lastActiveWorktreeIdByWorkspaceRefId, lastMobileSurfaceByWorkspaceRefId, paneContext, publishIssue, router, workspaceRefs]);
    return React.useMemo(() => Object.defineProperties(open, {
        resolution: { configurable: true, get: () => issueRef.current },
        dismissResolution: { configurable: true, value: () => publishIssue(null) },
    }) as OpenProject, [open, publishIssue]);
}
