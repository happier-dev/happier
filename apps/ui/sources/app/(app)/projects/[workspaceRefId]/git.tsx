import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { ProjectRightPanel } from '@/components/projects/detail/ProjectRightPanel';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';

export default function ProjectGitScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ workspaceRefId?: string | string[] }>();
    const raw = params.workspaceRefId;
    const workspaceRefId = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
            ? (raw[0] ?? '')
            : '';

    const workspaceRef = useWorkspaceRefById(workspaceRefId);

    if (!workspaceRef) {
        return <ProjectDetailScreen workspaceRefId={workspaceRefId} />;
    }

    const scopeId = buildProjectPaneScopeId(workspaceRef.id);
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const lastPushedDetailsRouteRef = React.useRef(false);

    React.useEffect(() => {
        lastPushedDetailsRouteRef.current = false;
    }, [workspaceRef.id]);

    React.useEffect(() => {
        if (!isFocused) return;
        openRight({ tabId: 'git' });
        if (pane.scopeState?.right?.activeTabId !== 'git') {
            setRightTab('git');
        }
    }, [isFocused, openRight, pane.scopeState?.right?.activeTabId, setRightTab]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!detailsIsOpen) {
            lastPushedDetailsRouteRef.current = false;
            return;
        }
        if (!detailsTabs.length) return;
        if (lastPushedDetailsRouteRef.current) return;
        lastPushedDetailsRouteRef.current = true;
        router.push(`/projects/${encodeURIComponent(workspaceRef.id)}/details`);
    }, [detailsIsOpen, detailsTabs.length, isFocused, router, workspaceRef.id]);

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: `/projects/${encodeURIComponent(workspaceRef.id)}` });
    }, [closeRight, navigation, router, workspaceRef.id]);

    return (
        <View testID="project-git-screen" style={{ flex: 1 }}>
            <React.Suspense fallback={(
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}>
                <ProjectRightPanel workspaceRef={workspaceRef} scopeId={scopeId} onRequestClose={onRequestClose} />
            </React.Suspense>
        </View>
    );
}
