import * as React from 'react';
import { View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteHeaderOptions } from '@/components/projects/detail/useProjectRouteHeaderOptions';
import { ProjectWorktreeRecoveryToast } from '@/components/projects/detail/ProjectWorktreeRecoveryToast';
import {
    buildProjectRouteHref,
    normalizeProjectDetailsSourceSurface,
    readProjectRouteStringParam,
    resolveProjectRouteSelectionQuery,
    resolveProjectRouteSegment,
} from '@/components/projects/detail/projectRouteState';
import { useProjectMobileRoutePersistence } from '@/components/projects/detail/useProjectMobileRoutePersistence';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import { useProjectRouteRouterRef } from '@/components/projects/detail/useProjectRouteRouterRef';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';
import { resolveFullscreenDetailsRouteSelection } from '@/components/workspaceCockpit/resolveFullscreenDetailsRouteSelection';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

type ProjectDetailsRouteParams = {
    workspaceRefId?: string | string[];
    worktreeId?: string | string[];
    activeRootPath?: string | string[];
    showWorktrees?: string | string[];
    sourceSurface?: string | string[];
};

export default function ProjectDetailsScreenRoute() {
    const params = useLocalSearchParams<ProjectDetailsRouteParams>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';
    const workspaceRef = useWorkspaceRefById(workspaceRefId);

    if (!workspaceRef) {
        return <ProjectDetailScreen workspaceRefId={workspaceRefId} activeRootPath={readProjectRouteStringParam(params.activeRootPath)} />;
    }

    return <ResolvedProjectDetailsScreenRoute params={params} workspaceRef={workspaceRef} />;
}

function ResolvedProjectDetailsScreenRoute({
    params,
    workspaceRef,
}: {
    params: ProjectDetailsRouteParams;
    workspaceRef: WorkspaceRefV1;
}) {
    const { theme } = useUnistyles();
    const routerRef = useProjectRouteRouterRef();
    const isFocused = useIsFocused();
    const showWorktrees = readProjectRouteStringParam(params.showWorktrees) === '1';
    const sourceSurface = normalizeProjectDetailsSourceSurface(params.sourceSurface);
    const {
        cockpitEnabled,
        showWorkspaceExperienceToggle,
        workspaceExperienceToggleLabelKey,
        toggleWorkspaceExperience,
    } = useMobileWorkspaceExperienceState();

    const scopeId = buildProjectPaneScopeId(workspaceRef.id);
    const pane = useAppPaneScope(scopeId);
    const detailsState = pane.scopeState?.details ?? null;
    const detailsSelection = React.useMemo(() => resolveFullscreenDetailsRouteSelection({
        detailsTabs: detailsState?.tabs,
        activeDetailsKey: detailsState?.activeTabKey ?? null,
        detailsGroups: detailsState?.groups,
    }), [detailsState?.activeTabKey, detailsState?.groups, detailsState?.tabs]);
    const hasDetails = detailsSelection.hasAnyDetails;
    const detailsIsOpen = detailsState?.isOpen ?? false;
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
        isFocused,
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedSurface,
        resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => cockpitEnabled
            ? resolveProjectRoutePathForSurface({
                workspaceRefId: workspaceRef.id,
                surface: showWorktrees ? 'overview' : 'tabs',
                ...resolveProjectRouteSelectionQuery({
                    activeRootPath,
                    defaultRootPath: workspaceRef.rootPath,
                    activeWorktreeId,
                }),
            })
            : buildProjectRouteHref({
                workspaceRefId: workspaceRef.id,
                segment: 'details',
                activeRootPath,
                defaultRootPath: workspaceRef.rootPath,
                activeWorktreeId,
                showWorktrees,
                sourceSurface,
            }),
    });

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        showWorktrees,
        sourceSurface,
        pane,
    });
    const replaceOverviewVisibility = routeActions.replaceOverviewVisibility;
    const openTerminal = routeActions.openTerminal;
    const buildHref = routeActions.buildHref;
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
    const returnToProject = React.useCallback(() => {
        if (sourceSurface) {
            routerRef.current.replace(resolveProjectRoutePathForSurface({
                workspaceRefId: workspaceRef.id,
                surface: sourceSurface,
                ...resolveProjectRouteSelectionQuery({
                    activeRootPath: resolvedActiveRootPath,
                    defaultRootPath: workspaceRef.rootPath,
                    activeWorktreeId: resolvedActiveWorktreeId,
                }),
            }));
            return;
        }
        routerRef.current.replace(buildHref({ segment: fallbackSegment }));
    }, [buildHref, fallbackSegment, resolvedActiveRootPath, resolvedActiveWorktreeId, routerRef, sourceSurface, workspaceRef.id, workspaceRef.rootPath]);

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        testIdPrefix: 'project-mobile-header',
        showWorktreesButton: true,
        showWorkspaceExperienceButton: showWorkspaceExperienceToggle,
        workspaceExperienceToggleA11yLabel: t(workspaceExperienceToggleLabelKey),
        onBack: returnToProject,
        onToggleWorkspaceExperience: showWorkspaceExperienceToggle ? toggleWorkspaceExperience : undefined,
        onToggleWorktrees: handleToggleWorktrees,
        onOpenTerminal: handleOpenTerminal,
    });

    const { onRequestClose } = useFullscreenDetailsRouteController({
        resetKey: workspaceRef.id,
        enabled: !cockpitEnabled,
        isFocused,
        hydrated: true,
        detailsIsOpen,
        hasDetails,
        keepRouteWhenEmpty: showWorktrees,
        keepRouteWhenDetailsClose: showWorktrees,
        onDismissRoute: returnToProject,
        onCloseDetails: pane.closeDetails,
        onUnmount: cockpitEnabled ? undefined : pane.closeDetails,
    });

    return (
        <View testID="project-details-screen" style={{ flex: 1 }}>
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
                        surface={showWorktrees ? 'overview' : 'tabs'}
                        isFocused={isFocused}
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
