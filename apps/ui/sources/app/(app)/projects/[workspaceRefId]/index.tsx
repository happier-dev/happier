import * as React from 'react';
import { Redirect, Stack, type Href, useLocalSearchParams, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import {
    buildProjectRouteHref,
    readProjectRouteStringParam,
    readProjectRouteWorktreeSelection,
    resolveProjectRouteSegment,
    replaceProjectRouteSelection,
} from '@/components/projects/detail/projectRouteState';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';

export default React.memo(() => {
    const router = useRouter();
    const params = useLocalSearchParams<{
        workspaceRefId?: string | string[];
        worktreeId?: string | string[];
        activeRootPath?: string | string[];
        showWorktrees?: string | string[];
    }>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const rawWorktreeId = readProjectRouteStringParam(params.worktreeId);
    const rawLegacyActiveRootPath = readProjectRouteStringParam(params.activeRootPath);
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
    const deviceType = useDeviceType();
    const lastMobileRouteByWorkspaceRefId = useLocalSetting('projectLastMobileRouteByWorkspaceRefId');
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const scopeId = buildProjectPaneScopeId(workspaceRefId);
    const pane = useAppPaneScope(scopeId);
    const workspaceRef = useWorkspaceRefById(workspaceRefId);
    const fallbackRootPath = workspaceRef?.rootPath ?? readProjectRouteStringParam(params.activeRootPath) ?? '';
    const persistedRootPath = workspaceRefId
        ? (lastActiveRootPathByWorkspaceRefId?.[workspaceRefId] ?? null)
        : null;
    const persistedWorktreeId = workspaceRefId
        ? (lastActiveWorktreeIdByWorkspaceRefId?.[workspaceRefId] ?? null)
        : null;
    const routeSelection = fallbackRootPath
        ? readProjectRouteWorktreeSelection({
            rawWorktreeId: params.worktreeId,
            rawLegacyActiveRootPath: params.activeRootPath,
            defaultRootPath: fallbackRootPath,
            persistedActiveRootPath: typeof persistedRootPath === 'string' ? persistedRootPath : null,
            persistedWorktreeId: typeof persistedWorktreeId === 'string' ? persistedWorktreeId : null,
        })
        : { requestedRootPath: null, requestedWorktreeId: null };
    const {
        resolvedRootPath: activeRootPath,
        resolvedWorktreeId: activeWorktreeId,
        availableWorktrees,
    } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: workspaceRef?.rootPath ?? fallbackRootPath,
        requestedRootPath: routeSelection.requestedRootPath,
        requestedWorktreeId: routeSelection.requestedWorktreeId,
    });

    const handleSelectRootPath = React.useCallback((path: string) => {
        if (!workspaceRef) return;
        const nextWorktreeId = path === workspaceRef.rootPath
            ? null
            : (availableWorktrees?.find((worktree) => worktree.isPrunable !== true && worktree.path === path)?.id ?? null);
        replaceProjectRouteSelection({
            router,
            workspaceRefId: workspaceRef.id,
            activeRootPath: path,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId: nextWorktreeId,
            showWorktrees,
        });
    }, [availableWorktrees, router, showWorktrees, workspaceRef]);

    const handleSetShowWorktrees = React.useCallback((nextValue: boolean) => {
        if (!workspaceRef) return;
        replaceProjectRouteSelection({
            router,
            workspaceRefId: workspaceRef.id,
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId,
            showWorktrees: nextValue,
        });
    }, [activeRootPath, activeWorktreeId, fallbackRootPath, router, workspaceRef]);

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: activeRootPath ?? fallbackRootPath,
        activeWorktreeId,
        showWorktrees,
        pane,
    });

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: activeRootPath ?? fallbackRootPath,
        testIdPrefix: 'project-desktop-header',
        showWorktreesButton: true,
        onToggleWorktrees: () => routeActions.replaceOverviewVisibility({ visible: !showWorktrees }),
        onOpenTerminal: () => routeActions.openTerminal({ exitOverview: true }),
    });

    if (workspaceRefId && deviceType === 'phone') {
        const activeTabId = resolveProjectRouteSegment(
            pane.scopeState?.right?.activeTabId,
            typeof lastMobileRouteByWorkspaceRefId?.[workspaceRefId] === 'string'
                ? lastMobileRouteByWorkspaceRefId[workspaceRefId]
                : null,
        );
        if (!workspaceRef) {
            const queryParams = new URLSearchParams();
            if (rawWorktreeId) {
                queryParams.set('worktreeId', rawWorktreeId);
            } else if (rawLegacyActiveRootPath) {
                queryParams.set('activeRootPath', rawLegacyActiveRootPath);
            }
            const query = queryParams.toString();
            const href = (
                query
                    ? `/projects/${encodeURIComponent(workspaceRefId)}/${activeTabId}?${query}`
                    : `/projects/${encodeURIComponent(workspaceRefId)}/${activeTabId}`
            ) as Href;
            return <Redirect href={href} />;
        }
        const href = buildProjectRouteHref({
            workspaceRefId,
            segment: activeTabId,
            activeRootPath: activeRootPath ?? fallbackRootPath,
            defaultRootPath: workspaceRef?.rootPath ?? '',
            activeWorktreeId,
        }) as Href;
        return <Redirect href={href} />;
    }

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ProjectDetailScreen
                workspaceRefId={workspaceRefId}
                activeRootPath={activeRootPath}
                showWorktrees={showWorktrees}
                onSelectRootPath={handleSelectRootPath}
                onSetShowWorktrees={handleSetShowWorktrees}
            />
        </>
    );
});
