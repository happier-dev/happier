import * as React from 'react';
import { useRouter } from 'expo-router';

import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';

import {
    PROJECT_ROUTE_ROOT_SENTINEL,
    readProjectRouteWorktreeSelection,
} from './projectRouteState';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';

export function useProjectMobileRoutePersistence(params: Readonly<{
    workspaceRef: WorkspaceRefV1;
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
    const router = useRouter();
    const lastMobileSurfaceByWorkspaceRefId = useLocalSetting('projectLastMobileSurfaceByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setLastMobileSurfaceByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileSurfaceByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastActiveWorktreeIdByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveWorktreeIdByWorkspaceRefId');

    const persistedActiveRootPath = lastActiveRootPathByWorkspaceRefId?.[params.workspaceRef.id];
    const persistedActiveWorktreeId = lastActiveWorktreeIdByWorkspaceRefId?.[params.workspaceRef.id];
    const routeSelection = readProjectRouteWorktreeSelection({
        rawWorktreeId: params.rawWorktreeId,
        rawLegacyActiveRootPath: params.rawActiveRootPath,
        defaultRootPath: params.workspaceRef.rootPath,
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
        serverId: params.workspaceRef.serverId,
        machineId: params.workspaceRef.machineId,
        defaultRootPath: params.workspaceRef.rootPath,
        requestedRootPath: routeSelection.requestedRootPath,
        requestedWorktreeId: routeSelection.requestedWorktreeId,
    });
    const recoveryToastKey = didRecoverMissingWorktree
        ? `${params.workspaceRef.id}:${requestedRootPath}`
        : null;

    const setRouteActiveRootPath = React.useCallback((path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        const nextWorktreeId = trimmedPath === params.workspaceRef.rootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        router.replace(params.resolveRouteHref({
            activeRootPath: trimmedPath,
            activeWorktreeId: nextWorktreeId,
        }));
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: trimmedPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: nextWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL,
        });
    }, [
        availableWorktrees,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        params,
        router,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
    ]);

    React.useEffect(() => {
        if (lastMobileSurfaceByWorkspaceRefId?.[params.workspaceRef.id] === params.persistedSurface) return;
        setLastMobileSurfaceByWorkspaceRefId({
            ...(lastMobileSurfaceByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: params.persistedSurface,
        });
    }, [
        lastMobileSurfaceByWorkspaceRefId,
        params.persistedSurface,
        params.workspaceRef.id,
        setLastMobileSurfaceByWorkspaceRefId,
    ]);

    React.useEffect(() => {
        const didCanonicalizeRootPath = requestedRootPath !== resolvedActiveRootPath;
        const didCanonicalizeWorktreeId = requestedWorktreeId !== resolvedActiveWorktreeId;
        if (!didCanonicalizeRootPath && !didCanonicalizeWorktreeId) return;
        router.replace(params.resolveRouteHref({
            activeRootPath: resolvedActiveRootPath,
            activeWorktreeId: resolvedActiveWorktreeId,
        }));
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: resolvedActiveRootPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: resolvedActiveWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL,
        });
    }, [
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        params,
        requestedRootPath,
        requestedWorktreeId,
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        router,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
    ]);

    return {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
        setRouteActiveRootPath,
    };
}
