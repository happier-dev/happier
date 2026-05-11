import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import { ProjectWorktreeRecoveryToast } from '@/components/projects/detail/ProjectWorktreeRecoveryToast';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { useProjectMobileRoutePersistence } from '@/components/projects/detail/useProjectMobileRoutePersistence';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { t } from '@/text';

export default function ProjectTerminalScreenRoute() {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{
        workspaceRefId?: string | string[];
        worktreeId?: string | string[];
        activeRootPath?: string | string[];
    }>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const {
        cockpitEnabled,
        showWorkspaceExperienceToggle,
        workspaceExperienceToggleLabelKey,
        toggleWorkspaceExperience,
    } = useMobileWorkspaceExperienceState();

    const workspaceRef = useWorkspaceRefById(workspaceRefId);

    if (!workspaceRef) {
        return <ProjectDetailScreen workspaceRefId={workspaceRefId} activeRootPath={readProjectRouteStringParam(params.activeRootPath)} />;
    }

    const scopeId = buildProjectPaneScopeId(workspaceRef.id);
    const pane = useAppPaneScope(scopeId);
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const detailsIsOpen = detailsState?.isOpen ?? false;
    const {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
    } = useProjectMobileRoutePersistence({
        workspaceRef,
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedSurface: 'terminal',
        resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => resolveProjectRoutePathForSurface({
            workspaceRefId: workspaceRef.id,
            surface: 'terminal',
            rawWorktreeId: activeRootPath === workspaceRef.rootPath ? '@root' : activeWorktreeId,
        }),
    });

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        pane,
    });
    const openWorktreesInDetails = routeActions.openWorktreesInDetails;
    const openTerminal = routeActions.openTerminal;
    const handleOpenWorktrees = React.useCallback(() => {
        openWorktreesInDetails('push');
    }, [openWorktreesInDetails]);
    const handleOpenTerminal = React.useCallback(() => {
        openTerminal();
    }, [openTerminal]);

    const handleNavigateToDetails = React.useCallback(() => {
        routeActions.navigateToSegment({ segment: 'details', method: 'push' });
    }, [routeActions]);

    useFullscreenDetailsRouteAutoRedirect({
        resetKey: workspaceRef.id,
        enabled: !cockpitEnabled,
        isFocused,
        detailsIsOpen,
        detailsSelection,
        onNavigate: handleNavigateToDetails,
    });

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        testIdPrefix: 'project-mobile-header',
        showWorktreesButton: true,
        showWorkspaceExperienceButton: showWorkspaceExperienceToggle,
        workspaceExperienceToggleA11yLabel: t(workspaceExperienceToggleLabelKey),
        onToggleWorkspaceExperience: showWorkspaceExperienceToggle ? toggleWorkspaceExperience : undefined,
        onToggleWorktrees: handleOpenWorktrees,
        onOpenTerminal: handleOpenTerminal,
    });

    return (
        <View testID={cockpitEnabled ? undefined : 'project-terminal-screen'} style={{ flex: 1 }}>
            <Stack.Screen options={screenOptions} />
            <React.Suspense fallback={(
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator color={theme.colors.text.secondary} />
                </View>
            )}>
                {cockpitEnabled ? (
                    <ProjectCockpitShell
                        workspaceRef={workspaceRef}
                        scopeId={scopeId}
                        activeRootPath={resolvedActiveRootPath}
                        activeWorktreeId={resolvedActiveWorktreeId}
                        surface="terminal"
                        onSelectRootPath={() => {}}
                    />
                ) : (
                    <ProjectTerminalSurface
                        scopeId={scopeId}
                        workspaceRefId={workspaceRef.id}
                        machineId={workspaceRef.machineId}
                        rootPath={resolvedActiveRootPath}
                        serverId={workspaceRef.serverId}
                    />
                )}
            </React.Suspense>
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
}
