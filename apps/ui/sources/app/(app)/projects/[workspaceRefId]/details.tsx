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
    const persistedRouteSegment = detailsIsOpen || hasDetails ? 'details' : fallbackSegment;
    const {
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        recoveryToastKey,
        setRouteActiveRootPath,
    } = useProjectMobileRoutePersistence({
        workspaceRef,
        routeSegment: 'details',
        showWorktrees,
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedRouteSegment,
    });

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        showWorktrees,
        pane,
    });

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        testIdPrefix: 'project-mobile-header',
        showWorktreesButton: true,
        onToggleWorktrees: () => routeActions.replaceOverviewVisibility({
            segment: 'details',
            visible: !showWorktrees,
        }),
        onOpenTerminal: () => routeActions.openTerminal({
            segment: 'details',
            exitOverview: true,
        }),
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
            pane.closeDetails();
        };
    }, [pane]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!hasMountedRef.current) return;
        if (showWorktrees) return;
        if (hasDetails) return;
        returnToProject();
    }, [hasDetails, isFocused, returnToProject, showWorktrees]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!hasMountedRef.current) return;
        if (showWorktrees) return;
        if (prevDetailsIsOpenRef.current && !detailsIsOpen) returnToProject();
        prevDetailsIsOpenRef.current = detailsIsOpen;
    }, [detailsIsOpen, isFocused, returnToProject, showWorktrees]);

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
                <ProjectDetailsMainPanel
                    scopeId={scopeId}
                    workspaceRef={workspaceRef}
                    activeRootPath={resolvedActiveRootPath}
                    activeWorktreeId={resolvedActiveWorktreeId}
                    forceOverviewMode={showWorktrees}
                    onSelectRootPath={setRouteActiveRootPath}
                    onRequestClose={onRequestClose}
                />
            </React.Suspense>
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
}
