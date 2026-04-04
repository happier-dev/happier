import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
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

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: resolveWorkspaceRefDisplayName(workspaceRef),
        headerBackTitle: t('common.back'),
    }), [workspaceRef]);

    const scopeId = buildProjectPaneScopeId(workspaceRef.id);
    const pane = useAppPaneScope(scopeId);
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
        router.push(`/projects/${encodeURIComponent(workspaceRef.id)}/details`);
    }, [activeDetailsKey, detailsIsOpen, detailsTabs, isFocused, router, workspaceRef.id]);

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: `/projects/${encodeURIComponent(workspaceRef.id)}` });
    }, [closeRight, navigation, router, workspaceRef.id]);

    return (
        <View testID="project-git-screen" style={{ flex: 1 }}>
            <Stack.Screen options={screenOptions} />
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
