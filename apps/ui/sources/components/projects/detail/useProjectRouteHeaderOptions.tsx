import * as React from 'react';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { ProjectHeaderActions } from './ProjectHeaderActions';
import { resolveProjectRouteHeaderTitle } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { Icon } from '@/components/ui/icons/Icon';
import { useDeviceType } from '@/utils/platform/responsive';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
    onOpenBrowser?: () => void;
    onOpenTerminal: () => void;
}>): Readonly<Record<string, unknown>> {
    const routerRef = useProjectRouteRouterRef();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    // Back, worktrees, the browser and Terminal are the phone bar's controls. Wider screens draw the Project
    // header (`ProjectShellHeader`), whose tab bar owns the checkout (branch) and Terminal; lending
    // these too drew a second Back/branch/terminal row beside the page title (DA R-12).
    const phoneBar = useDeviceType() === 'phone';
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
        // The repository under the name (lab `p-overview` HOMEp); a folder without one stays name-only.
        headerSubtitle: params.workspaceRef?.repositoryIdentity?.repository,
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
        ...(phoneBar ? {
        headerLeft: () => (
            <HappierPressable
                testID={`${params.testIdPrefix}-back`}
                onPress={handleBack}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
                style={{ paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s6 }}
            >
                <Icon name="arrow-left" size={24} color={theme.colors.chrome.header.foreground} />
            </HappierPressable>
        ),
        headerRight: () => (
            <ProjectHeaderActions
                testIdPrefix={params.testIdPrefix}
                showWorktreesButton={params.showWorktreesButton}
                showWorkspaceExperienceButton={params.showWorkspaceExperienceButton}
                workspaceExperienceToggleA11yLabel={params.workspaceExperienceToggleA11yLabel}
                onToggleWorkspaceExperience={params.onToggleWorkspaceExperience}
                onOpenWorktrees={params.onToggleWorktrees}
                onOpenBrowser={params.onOpenBrowser}
                onOpenTerminal={params.onOpenTerminal}
            />
        ),
        } : {}),
    }), [
        phoneBar,
        handleBack,
        params.activeRootPath,
        params.onBack,
        params.onOpenBrowser,
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
