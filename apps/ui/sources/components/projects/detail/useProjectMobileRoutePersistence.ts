import * as React from 'react';
import { useRouter } from 'expo-router';

import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';

import {
    buildProjectRouteHref,
    PROJECT_ROUTE_ROOT_SENTINEL,
    readProjectRouteWorktreeSelection,
    type ProjectRouteSegment,
} from './projectRouteState';

export function useProjectMobileRoutePersistence(params: Readonly<{
    workspaceRef: WorkspaceRefV1;
    routeSegment: ProjectRouteSegment;
    showWorktrees?: boolean;
    rawWorktreeId?: string | string[] | undefined;
    rawActiveRootPath: string | string[] | undefined;
    persistedRouteSegment: ProjectRouteSegment;
}>): Readonly<{
    resolvedActiveRootPath: string;
    resolvedActiveWorktreeId: string | null;
    recoveryToastKey: string | null;
    setRouteActiveRootPath: (path: string) => void;
}> {
    const router = useRouter();
    const lastMobileRouteByWorkspaceRefId = useLocalSetting('projectLastMobileRouteByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setLastMobileRouteByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileRouteByWorkspaceRefId');
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
        router.replace(buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id,
            segment: params.routeSegment,
            activeRootPath: trimmedPath,
            defaultRootPath: params.workspaceRef.rootPath,
            activeWorktreeId: nextWorktreeId,
            showWorktrees: params.showWorktrees,
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
        params.workspaceRef.id,
        params.workspaceRef.rootPath,
        params.routeSegment,
        params.showWorktrees,
        router,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
    ]);

    React.useEffect(() => {
        if (lastMobileRouteByWorkspaceRefId?.[params.workspaceRef.id] === params.persistedRouteSegment) return;
        setLastMobileRouteByWorkspaceRefId({
            ...(lastMobileRouteByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: params.persistedRouteSegment,
        });
    }, [
        lastMobileRouteByWorkspaceRefId,
        params.persistedRouteSegment,
        params.workspaceRef.id,
        setLastMobileRouteByWorkspaceRefId,
    ]);

    React.useEffect(() => {
        if (requestedRootPath === resolvedActiveRootPath) return;
        router.replace(buildProjectRouteHref({
            workspaceRefId: params.workspaceRef.id,
            segment: params.routeSegment,
            activeRootPath: resolvedActiveRootPath,
            defaultRootPath: params.workspaceRef.rootPath,
            activeWorktreeId: resolvedActiveWorktreeId,
            showWorktrees: params.showWorktrees,
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
        params.workspaceRef.id,
        params.workspaceRef.rootPath,
        params.routeSegment,
        params.showWorktrees,
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
