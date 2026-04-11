import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import { ProjectWorktreeRecoveryToast } from '@/components/projects/detail/ProjectWorktreeRecoveryToast';
import {
    buildProjectRouteHref,
    readProjectRouteStringParam,
    resolveProjectRouteSegment,
} from '@/components/projects/detail/projectRouteState';
import { useProjectMobileRoutePersistence } from '@/components/projects/detail/useProjectMobileRoutePersistence';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { t } from '@/text';

export default function ProjectDetailsScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{
        workspaceRefId?: string | string[];
        worktreeId?: string | string[];
        activeRootPath?: string | string[];
        showWorktrees?: string | string[];
    }>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
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
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const hasDetails = detailsTabs.length > 0;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const hasMountedRef = React.useRef(false);
    const prevDetailsIsOpenRef = React.useRef(detailsIsOpen);
    const fallbackSegment = resolveProjectRouteSegment(pane.scopeState?.right?.activeTabId, null);
    const persistedSurface = showWorktrees
        ? 'overview'
        : detailsIsOpen || hasDetails
            ? 'tabs'
            : fallbackSegment === 'git'
                ? 'git'
                : 'browse';
    const {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
        setRouteActiveRootPath,
    } = useProjectMobileRoutePersistence({
        workspaceRef,
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedSurface,
        resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => cockpitEnabled
            ? resolveProjectRoutePathForSurface({
                workspaceRefId: workspaceRef.id,
                surface: showWorktrees ? 'overview' : 'tabs',
                rawWorktreeId: activeRootPath === workspaceRef.rootPath ? '@root' : activeWorktreeId,
            })
            : buildProjectRouteHref({
                workspaceRefId: workspaceRef.id,
                segment: 'details',
                activeRootPath,
                defaultRootPath: workspaceRef.rootPath,
                activeWorktreeId,
                showWorktrees,
            }),
    });

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        showWorktrees,
        pane,
    });
    const replaceOverviewVisibility = routeActions.replaceOverviewVisibility;
    const openTerminal = routeActions.openTerminal;
    const handleToggleWorktrees = React.useCallback(() => {
        replaceOverviewVisibility({
            segment: 'details',
            visible: !showWorktrees,
        });
    }, [replaceOverviewVisibility, showWorktrees]);
    const handleOpenTerminal = React.useCallback(() => {
        openTerminal({
            segment: 'details',
            exitOverview: true,
        });
    }, [openTerminal]);

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        testIdPrefix: 'project-mobile-header',
        showWorktreesButton: true,
        showWorkspaceExperienceButton: showWorkspaceExperienceToggle,
        workspaceExperienceToggleA11yLabel: t(workspaceExperienceToggleLabelKey),
        onToggleWorkspaceExperience: showWorkspaceExperienceToggle ? toggleWorkspaceExperience : undefined,
        onToggleWorktrees: handleToggleWorktrees,
        onOpenTerminal: handleOpenTerminal,
    });

    const returnToProject = React.useCallback(() => {
        safeRouterBack({
            router,
            navigation,
            fallbackHref: routeActions.buildHref({ segment: fallbackSegment }),
        });
    }, [fallbackSegment, navigation, routeActions, router]);

    React.useEffect(() => {
        hasMountedRef.current = true;
        return () => {
            hasMountedRef.current = false;
            if (!cockpitEnabled) {
                pane.closeDetails();
            }
        };
    }, [cockpitEnabled, pane]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!hasMountedRef.current) return;
        if (showWorktrees) return;
        if (cockpitEnabled) return;
        if (hasDetails) return;
        returnToProject();
    }, [cockpitEnabled, hasDetails, isFocused, returnToProject, showWorktrees]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!hasMountedRef.current) return;
        if (showWorktrees) return;
        if (cockpitEnabled) return;
        if (prevDetailsIsOpenRef.current && !detailsIsOpen) returnToProject();
        prevDetailsIsOpenRef.current = detailsIsOpen;
    }, [cockpitEnabled, detailsIsOpen, isFocused, returnToProject, showWorktrees]);

    const onRequestClose = React.useCallback(() => {
        if (!detailsIsOpen) {
            returnToProject();
            return;
        }
        pane.closeDetails();
    }, [detailsIsOpen, pane, returnToProject]);

    return (
        <View testID="project-details-screen" style={{ flex: 1 }}>
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
                        surface={showWorktrees ? 'overview' : 'tabs'}
                        onSelectRootPath={setRouteActiveRootPath}
                    />
                ) : (
                    <ProjectDetailsMainPanel
                        scopeId={scopeId}
                        workspaceRef={workspaceRef}
                        activeRootPath={resolvedActiveRootPath}
                        activeWorktreeId={resolvedActiveWorktreeId}
                        forceOverviewMode={showWorktrees}
                        onSelectRootPath={setRouteActiveRootPath}
                        onRequestClose={onRequestClose}
                    />
                )}
            </React.Suspense>
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
}
