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
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';

export default function ProjectDetailsScreenRoute() {
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
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const hasDetails = detailsTabs.length > 0;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const hasMountedRef = React.useRef(false);
    const prevDetailsIsOpenRef = React.useRef(detailsIsOpen);

    const returnToProject = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: `/projects/${encodeURIComponent(workspaceRef.id)}` });
    }, [navigation, router, workspaceRef.id]);

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
        if (hasDetails) return;
        returnToProject();
    }, [hasDetails, isFocused, returnToProject]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!hasMountedRef.current) return;
        if (prevDetailsIsOpenRef.current && !detailsIsOpen) returnToProject();
        prevDetailsIsOpenRef.current = detailsIsOpen;
    }, [detailsIsOpen, isFocused, returnToProject]);

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
                    onRequestClose={onRequestClose}
                />
            </React.Suspense>
        </View>
    );
}
