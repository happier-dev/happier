import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { ProjectRightPanel } from '@/components/projects/detail/ProjectRightPanel';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import { ProjectWorktreeRecoveryToast } from '@/components/projects/detail/ProjectWorktreeRecoveryToast';
import { readProjectRouteStringParam } from '@/components/projects/detail/projectRouteState';
import { useProjectMobileRoutePersistence } from '@/components/projects/detail/useProjectMobileRoutePersistence';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { useLegacyDetailsRouteRedirect } from '@/components/workspaceCockpit/useLegacyDetailsRouteRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { t } from '@/text';

export default function ProjectFilesScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
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
    const {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
        setRouteActiveRootPath,
    } = useProjectMobileRoutePersistence({
        workspaceRef,
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedSurface: 'browse',
        resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => resolveProjectRoutePathForSurface({
            workspaceRefId: workspaceRef.id,
            surface: 'browse',
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
    const { syncSurface } = useProjectSurfaceController({
        scopeId,
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
    });
    const closeRight = pane.closeRight;

    const activeDetailsKey = pane.scopeState?.details?.activeTabKey ?? null;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];

    React.useEffect(() => {
        if (!isFocused) return;
        syncSurface('browse');
    }, [isFocused, syncSurface]);

    const handleNavigateToDetails = React.useCallback(() => {
        routeActions.navigateToSegment({ segment: 'details', method: 'push' });
    }, [routeActions]);

    useLegacyDetailsRouteRedirect({
        resetKey: workspaceRef.id,
        enabled: !cockpitEnabled,
        isFocused,
        detailsIsOpen,
        activeDetailsKey,
        detailsTabs,
        onNavigate: handleNavigateToDetails,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({
            router,
            navigation,
            fallbackHref: routeActions.buildHref(),
        });
    }, [closeRight, navigation, routeActions, router]);

    return (
        <View testID={cockpitEnabled ? undefined : 'project-files-screen'} style={{ flex: 1 }}>
            <Stack.Screen options={screenOptions} />
            <React.Suspense fallback={(
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}>
                {cockpitEnabled ? (
                    <ProjectCockpitShell
                        workspaceRef={workspaceRef}
                        scopeId={scopeId}
                        activeRootPath={resolvedActiveRootPath}
                        activeWorktreeId={resolvedActiveWorktreeId}
                        surface="browse"
                        onSelectRootPath={setRouteActiveRootPath}
                    />
                ) : (
                    <ProjectRightPanel
                        workspaceRef={workspaceRef}
                        scopeId={scopeId}
                        activeRootPath={resolvedActiveRootPath}
                        activeWorktreeId={resolvedActiveWorktreeId}
                        onSelectRootPath={setRouteActiveRootPath}
                        onRequestClose={onRequestClose}
                    />
                )}
            </React.Suspense>
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
}
