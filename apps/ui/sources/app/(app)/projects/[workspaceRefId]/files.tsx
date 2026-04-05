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
        routeSegment: 'files',
        rawWorktreeId: params.worktreeId,
        rawActiveRootPath: params.activeRootPath,
        persistedRouteSegment: 'files',
    });

    const routeActions = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        pane,
    });

    const screenOptions = useProjectRouteHeaderOptions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        testIdPrefix: 'project-mobile-header',
        showWorktreesButton: true,
        onToggleWorktrees: () => routeActions.openWorktreesInDetails('push'),
        onOpenTerminal: () => routeActions.openTerminal(),
    });
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const activeDetailsKey = pane.scopeState?.details?.activeTabKey ?? null;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const lastPushedDetailsKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        lastPushedDetailsKeyRef.current = null;
    }, [workspaceRef.id]);

    React.useEffect(() => {
        if (!isFocused) return;
        openRight({ tabId: 'files' });
        if (pane.scopeState?.right?.activeTabId !== 'files') {
            setRightTab('files');
        }
    }, [isFocused, openRight, pane.scopeState?.right?.activeTabId, setRightTab]);

    React.useEffect(() => {
        if (!detailsIsOpen) {
            lastPushedDetailsKeyRef.current = null;
            return;
        }
        if (!isFocused) return;
        if (!detailsTabs.length) return;
        const key = typeof activeDetailsKey === 'string' && activeDetailsKey
            ? activeDetailsKey
            : detailsTabs.at(-1)?.key ?? null;
        if (!key) return;
        if (lastPushedDetailsKeyRef.current === key) return;
        lastPushedDetailsKeyRef.current = key;
        routeActions.navigateToSegment({ segment: 'details', method: 'push' });
    }, [activeDetailsKey, detailsIsOpen, detailsTabs, isFocused, routeActions]);

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({
            router,
            navigation,
            fallbackHref: routeActions.buildHref(),
        });
    }, [closeRight, navigation, routeActions, router]);

    return (
        <View testID="project-files-screen" style={{ flex: 1 }}>
            <Stack.Screen options={screenOptions} />
            <React.Suspense fallback={(
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}>
                <ProjectRightPanel
                    workspaceRef={workspaceRef}
                    scopeId={scopeId}
                    activeRootPath={resolvedActiveRootPath}
                    activeWorktreeId={resolvedActiveWorktreeId}
                    onSelectRootPath={setRouteActiveRootPath}
                    onRequestClose={onRequestClose}
                />
            </React.Suspense>
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
}
