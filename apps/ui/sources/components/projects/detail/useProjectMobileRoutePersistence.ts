import * as React from 'react';

import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';

import {
    PROJECT_ROUTE_ROOT_SENTINEL,
    readProjectRouteWorktreeSelection,
} from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';

export function useProjectMobileRoutePersistence(params: Readonly<{
    workspaceRef: WorkspaceRefV1;
    isFocused: boolean;
    rawWorktreeId?: string | string[] | undefined;
    rawActiveRootPath: string | string[] | undefined;
    persistedSurface: ProjectMobileSurface;
    resolveRouteHref: (input: Readonly<{
        activeRootPath: string;
        activeWorktreeId: string | null;
    }>) => string;
}>): Readonly<{
    resolvedActiveRootPath: string;
    resolvedActiveWorktreeId: string | null;
    recoveryToastKey: string | null;
    setRouteActiveRootPath: (path: string) => void;
}> {
    const {
        isFocused,
        persistedSurface,
        rawActiveRootPath,
        rawWorktreeId,
        resolveRouteHref,
        workspaceRef,
    } = params;
    const resolveRouteHrefRef = React.useRef(resolveRouteHref);
    resolveRouteHrefRef.current = resolveRouteHref;

    const routerRef = useProjectRouteRouterRef();
    const lastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setLastMobileSurfaceByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastActiveWorktreeIdByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveWorktreeIdByWorkspaceRefId');

    const workspaceRefId = workspaceRef.id;
    const workspaceRootPath = workspaceRef.rootPath;
    const persistedActiveRootPath = lastActiveRootPathByWorkspaceRefId?.[workspaceRefId];
    const persistedActiveWorktreeId = lastActiveWorktreeIdByWorkspaceRefId?.[workspaceRefId];
    const routeSelection = readProjectRouteWorktreeSelection({
        rawWorktreeId,
        rawLegacyActiveRootPath: rawActiveRootPath,
        defaultRootPath: workspaceRootPath,
        persistedActiveRootPath: typeof persistedActiveRootPath === 'string' ? persistedActiveRootPath : null,
        persistedWorktreeId: typeof persistedActiveWorktreeId === 'string' ? persistedActiveWorktreeId : null,
    });
    const {
        requestedRootPath,
        requestedWorktreeId,
        resolvedRootPath: resolvedActiveRootPath,
        resolvedWorktreeId: resolvedActiveWorktreeId,
        didRecoverMissingWorktree,
        availableWorktrees,
    } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef.serverId,
        machineId: workspaceRef.machineId,
        defaultRootPath: workspaceRootPath,
        requestedRootPath: routeSelection.requestedRootPath,
        requestedWorktreeId: routeSelection.requestedWorktreeId,
    });
    const recoveryToastKey = didRecoverMissingWorktree
        ? `${workspaceRefId}:${requestedRootPath}`
        : null;

    const setRouteActiveRootPath = React.useCallback((path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        const nextWorktreeId = trimmedPath === workspaceRootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        routerRef.current.replace(resolveRouteHrefRef.current({
            activeRootPath: trimmedPath,
            activeWorktreeId: nextWorktreeId,
        }));
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [workspaceRefId]: trimmedPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [workspaceRefId]: nextWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL,
        });
    }, [
        availableWorktrees,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        routerRef,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
        workspaceRefId,
        workspaceRootPath,
    ]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (lastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] === persistedSurface) return;
        setLastMobileSurfaceByWorkspaceRefId({
            ...(lastMobileSurfaceByWorkspaceRefId ?? {}),
            [workspaceRefId]: persistedSurface,
        });
    }, [
        isFocused,
        lastMobileSurfaceByWorkspaceRefId,
        persistedSurface,
        setLastMobileSurfaceByWorkspaceRefId,
        workspaceRefId,
    ]);

    React.useEffect(() => {
        if (!isFocused) return;
        const didCanonicalizeRootPath = requestedRootPath !== resolvedActiveRootPath;
        const didCanonicalizeWorktreeId = requestedWorktreeId !== resolvedActiveWorktreeId;
        if (!didCanonicalizeRootPath && !didCanonicalizeWorktreeId) return;
        routerRef.current.replace(resolveRouteHrefRef.current({
            activeRootPath: resolvedActiveRootPath,
            activeWorktreeId: resolvedActiveWorktreeId,
        }));
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [workspaceRefId]: resolvedActiveRootPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [workspaceRefId]: resolvedActiveWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL,
        });
    }, [
        isFocused,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        requestedRootPath,
        requestedWorktreeId,
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        routerRef,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
        workspaceRefId,
    ]);

    return {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
        setRouteActiveRootPath,
    };
}
