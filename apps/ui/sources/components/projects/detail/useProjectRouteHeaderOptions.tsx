import * as React from 'react';
import { Pressable } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { ProjectHeaderActions } from './ProjectHeaderActions';
import { resolveProjectRouteHeaderTitle } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

export function useProjectRouteHeaderOptions(params: Readonly<{
    workspaceRef: WorkspaceRefV1 | null;
    activeRootPath?: string | null;
    testIdPrefix: string;
    showWorktreesButton: boolean;
    showWorkspaceExperienceButton?: boolean;
    workspaceExperienceToggleA11yLabel?: string;
    onBack?: () => void;
    onToggleWorkspaceExperience?: () => void;
    onToggleWorktrees?: () => void;
    onOpenTerminal: () => void;
}>): Readonly<Record<string, unknown>> {
    const routerRef = useProjectRouteRouterRef();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const navigationRef = React.useRef(navigation);
    navigationRef.current = navigation;
    const onBack = params.onBack;

    const handleBack = React.useCallback(() => {
        if (onBack) {
            onBack();
            return;
        }
        safeRouterBack({
            router: routerRef.current,
            navigation: navigationRef.current,
            fallbackHref: '/projects',
        });
    }, [onBack, routerRef]);

    return React.useMemo(() => ({
        headerShown: true,
        headerTitle: params.workspaceRef && params.activeRootPath
            ? resolveProjectRouteHeaderTitle(params.workspaceRef, params.activeRootPath)
            : t('projects.detail.groupTitle'),
        headerBackTitle: t('common.back'),
        headerBackVisible: false,
        headerStyle: {
            backgroundColor: theme.colors.chrome.header.background,
        },
        headerTintColor: theme.colors.chrome.header.foreground,
        headerTitleStyle: {
            color: theme.colors.chrome.header.foreground,
        },
        headerShadowVisible: false,
        headerLeft: () => (
            <Pressable
                testID={`${params.testIdPrefix}-back`}
                onPress={handleBack}
                hitSlop={15}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
                style={{ paddingHorizontal: 12, paddingVertical: 6 }}
            >
                <Ionicons name="arrow-back" size={24} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        ),
        headerRight: () => (
            <ProjectHeaderActions
                testIdPrefix={params.testIdPrefix}
                showWorktreesButton={params.showWorktreesButton}
                showWorkspaceExperienceButton={params.showWorkspaceExperienceButton}
                workspaceExperienceToggleA11yLabel={params.workspaceExperienceToggleA11yLabel}
                onToggleWorkspaceExperience={params.onToggleWorkspaceExperience}
                onOpenWorktrees={params.onToggleWorktrees}
                onOpenTerminal={params.onOpenTerminal}
            />
        ),
    }), [
        handleBack,
        params.activeRootPath,
        params.onBack,
        params.onOpenTerminal,
        params.onToggleWorkspaceExperience,
        params.onToggleWorktrees,
        params.showWorktreesButton,
        params.showWorkspaceExperienceButton,
        params.testIdPrefix,
        params.workspaceRef,
        params.workspaceExperienceToggleA11yLabel,
        theme.colors.chrome.header.background,
        theme.colors.chrome.header.foreground,
    ]);
}
