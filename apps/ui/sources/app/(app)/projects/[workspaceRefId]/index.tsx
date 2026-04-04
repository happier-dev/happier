import * as React from 'react';
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import {
    buildProjectRouteHref,
    readProjectRouteActiveRootPath,
    readProjectRouteStringParam,
    resolveProjectRouteSegment,
    resolveProjectRouteActiveRootParam,
} from '@/components/projects/detail/projectRouteState';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';

export default React.memo(() => {
    const router = useRouter();
    const params = useLocalSearchParams<{ workspaceRefId?: string | string[]; activeRootPath?: string | string[] }>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const deviceType = useDeviceType();
    const lastMobileRouteByWorkspaceRefId = useLocalSetting('projectLastMobileRouteByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const scopeId = buildProjectPaneScopeId(workspaceRefId);
    const pane = useAppPaneScope(scopeId);
    const workspaceRef = useWorkspaceRefById(workspaceRefId);
    const fallbackRootPath = workspaceRef?.rootPath ?? readProjectRouteStringParam(params.activeRootPath) ?? '';
    const persistedRootPath = workspaceRefId
        ? (lastActiveRootPathByWorkspaceRefId?.[workspaceRefId] ?? null)
        : null;
    const activeRootPath = fallbackRootPath
        ? readProjectRouteActiveRootPath(
            params.activeRootPath,
            fallbackRootPath,
            typeof persistedRootPath === 'string' ? persistedRootPath : null,
        )
        : null;

    const handleSelectRootPath = React.useCallback((path: string) => {
        if (!workspaceRef) return;
        router.setParams({
            activeRootPath: resolveProjectRouteActiveRootParam(path, workspaceRef.rootPath),
        });
    }, [router, workspaceRef]);

    if (workspaceRefId && deviceType === 'phone') {
        const activeTabId = resolveProjectRouteSegment(
            pane.scopeState?.right?.activeTabId,
            typeof lastMobileRouteByWorkspaceRefId?.[workspaceRefId] === 'string'
                ? lastMobileRouteByWorkspaceRefId[workspaceRefId]
                : null,
        );
        const href = buildProjectRouteHref({
            workspaceRefId,
            segment: activeTabId,
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef?.rootPath ?? '',
        }) as Href;
        return <Redirect href={href} />;
    }

    return (
        <ProjectDetailScreen
            workspaceRefId={workspaceRefId}
            activeRootPath={activeRootPath}
            onSelectRootPath={handleSelectRootPath}
        />
    );
});
