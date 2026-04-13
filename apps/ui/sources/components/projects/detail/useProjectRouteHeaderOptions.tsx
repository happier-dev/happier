import * as React from 'react';
import { Pressable } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { ProjectHeaderActions } from './ProjectHeaderActions';
import { resolveProjectRouteHeaderTitle } from './projectRouteState';

export function useProjectRouteHeaderOptions(params: Readonly<{
    workspaceRef: WorkspaceRefV1 | null;
    activeRootPath?: string | null;
    testIdPrefix: string;
    showWorktreesButton: boolean;
    showWorkspaceExperienceButton?: boolean;
    workspaceExperienceToggleA11yLabel?: string;
    onToggleWorkspaceExperience?: () => void;
    onToggleWorktrees?: () => void;
    onOpenTerminal: () => void;
}>): Readonly<Record<string, unknown>> {
    const router = useRouter();
    const navigation = useNavigation();
    const { theme } = useUnistyles();

    const handleBack = React.useCallback(() => {
        safeRouterBack({
            router,
            navigation,
            fallbackHref: '/projects',
        });
    }, [navigation, router]);

    return React.useMemo(() => ({
        headerShown: true,
        headerTitle: params.workspaceRef && params.activeRootPath
            ? resolveProjectRouteHeaderTitle(params.workspaceRef, params.activeRootPath)
            : t('projects.detail.groupTitle'),
        headerBackTitle: t('common.back'),
        headerBackVisible: false,
        headerStyle: {
            backgroundColor: theme.colors.header.background,
        },
        headerTintColor: theme.colors.header.tint,
        headerTitleStyle: {
            color: theme.colors.header.tint,
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
                <Ionicons name="arrow-back" size={24} color={theme.colors.header.tint} />
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
        params.onOpenTerminal,
        params.onToggleWorkspaceExperience,
        params.onToggleWorktrees,
        params.showWorktreesButton,
        params.showWorkspaceExperienceButton,
        params.testIdPrefix,
        params.workspaceRef,
        params.workspaceExperienceToggleA11yLabel,
        theme.colors.header.background,
        theme.colors.header.tint,
    ]);
}
