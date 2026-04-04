import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { ProjectMobileHeaderActions } from '@/components/projects/detail/ProjectMobileHeaderActions';
import { ProjectRightPanel } from '@/components/projects/detail/ProjectRightPanel';
import {
    buildProjectRouteHref,
    readProjectRouteStringParam,
    resolveProjectRouteHeaderTitle,
} from '@/components/projects/detail/projectRouteState';
import { useProjectMobileRoutePersistence } from '@/components/projects/detail/useProjectMobileRoutePersistence';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';

export default function ProjectGitScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ workspaceRefId?: string | string[]; activeRootPath?: string | string[] }>();
    const workspaceRefId = readProjectRouteStringParam(params.workspaceRefId) ?? '';

    const workspaceRef = useWorkspaceRefById(workspaceRefId);

    if (!workspaceRef) {
        return <ProjectDetailScreen workspaceRefId={workspaceRefId} activeRootPath={readProjectRouteStringParam(params.activeRootPath)} />;
    }

    const scopeId = buildProjectPaneScopeId(workspaceRef.id);
    const pane = useAppPaneScope(scopeId);
    const {
        resolvedActiveRootPath,
        setRouteActiveRootPath,
    } = useProjectMobileRoutePersistence({
        workspaceRef,
        rawActiveRootPath: params.activeRootPath,
        persistedRouteSegment: 'git',
    });

    const openTerminal = React.useCallback(() => {
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: 'terminal',
                    kind: 'terminal',
                    title: t('settings.terminal'),
                    resource: { kind: 'terminal' },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: resolveProjectRouteHeaderTitle(workspaceRef, resolvedActiveRootPath),
        headerBackTitle: t('common.back'),
        headerRight: () => (
            <ProjectMobileHeaderActions
                showWorktreesButton
                onOpenWorktrees={() => router.push(buildProjectRouteHref({
                    workspaceRefId: workspaceRef.id,
                    segment: 'details',
                    activeRootPath: resolvedActiveRootPath,
                    defaultRootPath: workspaceRef.rootPath,
                    showWorktrees: true,
                }))}
                onOpenTerminal={openTerminal}
            />
        ),
    }), [openTerminal, resolvedActiveRootPath, router, workspaceRef]);
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
        openRight({ tabId: 'git' });
        if (pane.scopeState?.right?.activeTabId !== 'git') {
            setRightTab('git');
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
        router.push(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment: 'details',
            activeRootPath: resolvedActiveRootPath,
            defaultRootPath: workspaceRef.rootPath,
        }));
    }, [activeDetailsKey, detailsIsOpen, detailsTabs, isFocused, resolvedActiveRootPath, router, workspaceRef.id, workspaceRef.rootPath]);

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({
            router,
            navigation,
            fallbackHref: buildProjectRouteHref({
                workspaceRefId: workspaceRef.id,
                activeRootPath: resolvedActiveRootPath,
                defaultRootPath: workspaceRef.rootPath,
            }),
        });
    }, [closeRight, navigation, resolvedActiveRootPath, router, workspaceRef.id, workspaceRef.rootPath]);

    return (
        <View testID="project-git-screen" style={{ flex: 1 }}>
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
                    onSelectRootPath={setRouteActiveRootPath}
                    onRequestClose={onRequestClose}
                />
            </React.Suspense>
        </View>
    );
}
