import * as React from 'react';
import { useRouter } from 'expo-router';

import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import {
    readProjectRouteActiveRootPath,
    resolveProjectRouteActiveRootParam,
    type ProjectRouteSegment,
} from './projectRouteState';

export function useProjectMobileRoutePersistence(params: Readonly<{
    workspaceRef: WorkspaceRefV1;
    rawActiveRootPath: string | string[] | undefined;
    persistedRouteSegment: ProjectRouteSegment;
}>): Readonly<{
    resolvedActiveRootPath: string;
    setRouteActiveRootPath: (path: string) => void;
}> {
    const router = useRouter();
    const lastMobileRouteByWorkspaceRefId = useLocalSetting('projectLastMobileRouteByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastMobileRouteByWorkspaceRefId] = useLocalSettingMutable('projectLastMobileRouteByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');

    const persistedActiveRootPath = lastActiveRootPathByWorkspaceRefId?.[params.workspaceRef.id];
    const resolvedActiveRootPath = readProjectRouteActiveRootPath(
        params.rawActiveRootPath,
        params.workspaceRef.rootPath,
        typeof persistedActiveRootPath === 'string' ? persistedActiveRootPath : null,
    );

    const setRouteActiveRootPath = React.useCallback((path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        router.setParams({
            activeRootPath: resolveProjectRouteActiveRootParam(trimmedPath, params.workspaceRef.rootPath),
        });
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [params.workspaceRef.id]: trimmedPath,
        });
    }, [
        lastActiveRootPathByWorkspaceRefId,
        params.workspaceRef.id,
        params.workspaceRef.rootPath,
        router,
        setLastActiveRootPathByWorkspaceRefId,
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

    return {
        resolvedActiveRootPath,
        setRouteActiveRootPath,
    };
}
