import * as React from 'react';
import { View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { ProjectRightPanel } from '@/components/projects/detail/ProjectRightPanel';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import { ProjectWorktreeRecoveryToast } from '@/components/projects/detail/ProjectWorktreeRecoveryToast';
import {
    migrateProjectRouteSegmentToMobileSurface,
    readProjectRouteStringParam,
    resolveProjectRouteSelectionQuery,
} from '@/components/projects/detail/projectRouteState';
import { useProjectMobileRoutePersistence } from '@/components/projects/detail/useProjectMobileRoutePersistence';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useProjectRouteSurfaceSync } from '@/components/projects/detail/useProjectRouteSurfaceSync';
import { useProjectRouteRouterRef } from '@/components/projects/detail/useProjectRouteRouterRef';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { useFullscreenDetailsRouteAutoRedirect } from '@/components/workspaceCockpit/useFullscreenDetailsRouteAutoRedirect';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

type ProjectFilesRouteParams = {
    workspaceRefId?: string | string[];
    worktreeId?: string | string[];
    activeRootPath?: string | string[];
    mobileSurface?: string | string[];
};

export default function ProjectFilesScreenRoute() {
    const params = useLocalSearchParams<ProjectFilesRouteParams>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const workspaceRef = useWorkspaceRefById(workspaceRefId);

    if (!workspaceRef) {
        return <ProjectDetailScreen workspaceRefId={workspaceRefId} activeRootPath={readProjectRouteStringParam(params.activeRootPath)} />;
    }

    return <ResolvedProjectFilesScreenRoute params={params} workspaceRef={workspaceRef} />;
}

function ResolvedProjectFilesScreenRoute({
    params,
    workspaceRef,
}: {
    params: ProjectFilesRouteParams;
    workspaceRef: WorkspaceRefV1;
}) {
    const { theme } = useUnistyles();
    const routerRef = useProjectRouteRouterRef();
    const navigation = useNavigation();
    const navigationRef = React.useRef(navigation);
    navigationRef.current = navigation;
    const isFocused = useIsFocused();
    const requestedMobileSurface = migrateProjectRouteSegmentToMobileSurface(readProjectRouteStringParam(params.mobileSurface));
    const routeSurface = requestedMobileSurface === 'browser' || requestedMobileSurface === 'services'
        ? requestedMobileSurface
        : 'browse';
    const {
        cockpitEnabled,
        showWorkspaceExperienceToggle,
        workspaceExperienceToggleLabelKey,
        toggleWorkspaceExperience,
    } = useMobileWorkspaceExperienceState();

    const scopeId = buildProjectPaneScopeId(workspaceRef.id);
    const pane = useAppPaneScope(scopeId);
    const {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
        setRouteActiveRootPath,
    } = useProjectMobileRoutePersistence({
        workspaceRef,
        isFocused,
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedSurface: routeSurface,
        resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => resolveProjectRoutePathForSurface({
            workspaceRefId: workspaceRef.id,
            surface: routeSurface,
            ...resolveProjectRouteSelectionQuery({
                activeRootPath,
                defaultRootPath: workspaceRef.rootPath,
                activeWorktreeId,
            }),
        }),
    });

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        sourceSurface: routeSurface,
        pane,
    });
    const openWorktreesInDetails = routeActions.openWorktreesInDetails;
    const openTerminal = routeActions.openTerminal;
    const buildHref = routeActions.buildHref;
    const navigateToSegment = routeActions.navigateToSegment;
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
    useProjectRouteSurfaceSync({
        scopeId,
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        isFocused: isFocused && !cockpitEnabled,
        surface: routeSurface,
    });
    const closeRight = pane.closeRight;

    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const detailsIsOpen = detailsState?.isOpen ?? false;

    const handleNavigateToDetails = React.useCallback(() => {
        navigateToSegment({ segment: 'details', method: 'push', sourceSurface: routeSurface });
    }, [navigateToSegment, routeSurface]);

    useFullscreenDetailsRouteAutoRedirect({
        resetKey: workspaceRef.id,
        enabled: !cockpitEnabled,
        isFocused,
        detailsIsOpen,
        detailsSelection,
        onNavigate: handleNavigateToDetails,
    });

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({
            router: routerRef.current,
            navigation: navigationRef.current,
            fallbackHref: buildHref(),
        });
    }, [buildHref, closeRight, routerRef]);

    return (
        <View testID={cockpitEnabled ? undefined : 'project-files-screen'} style={{ flex: 1 }}>
            <Stack.Screen options={screenOptions} />
            <React.Suspense fallback={(
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner color={theme.colors.text.secondary} />
                </View>
            )}>
                {cockpitEnabled ? (
                    <ProjectCockpitShell
                        workspaceRef={workspaceRef}
                        scopeId={scopeId}
                        activeRootPath={resolvedActiveRootPath}
                        activeWorktreeId={resolvedActiveWorktreeId}
                        surface={routeSurface}
                        isFocused={isFocused}
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
