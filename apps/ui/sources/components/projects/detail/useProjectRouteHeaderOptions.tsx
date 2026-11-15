import * as React from 'react';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { ProjectHeaderActions, type ProjectHeaderActionsProps } from './ProjectHeaderActions';
import { resolveProjectRouteHeaderTitle } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { Icon } from '@/components/ui/icons/Icon';
import { useDeviceType } from '@/utils/platform/responsive';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useDetailBottomBarPresented } from '@/components/navigation/mobile/chrome/presentedBottomChrome';

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
    /**
     * A phone page's own head (owner P1 11-15, `ProjectPhoneHead`): it draws the bar's controls around the
     * launchers, and the page draws the Project's name as its large title, so the bar carries none.
     */
    phoneHead?: (launchers: ProjectHeaderActionsProps) => React.ReactNode;
}>): Readonly<Record<string, unknown>> {
    const routerRef = useProjectRouteRouterRef();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    // Back, worktrees, the browser and Terminal are the phone bar's controls. Wider screens draw the Project
    // header (`ProjectShellHeader`), whose tab bar owns the checkout (branch) and Terminal; lending
    // these too drew a second Back/branch/terminal row beside the page title (DA R-12).
    const phoneBar = useDeviceType() === 'phone';
    // Where the Project cockpit bar is on screen, Browser and Terminal live in it and its ⋯ (owner 11-10); the
    // File page has no bar and keeps them here (lab FV1p). The bottom-chrome host decides which bar shows.
    const barHoldsTools = useDetailBottomBarPresented('project');
    const navigationRef = React.useRef(navigation);
    navigationRef.current = navigation;
    const onBack = params.onBack;
    const phoneHead = phoneBar ? params.phoneHead : undefined;

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
        headerTitle: phoneHead ? '' : params.workspaceRef && params.activeRootPath
            ? resolveProjectRouteHeaderTitle(params.workspaceRef, params.activeRootPath)
            : t('projects.detail.groupTitle'),
        // The repository under the name (lab `p-overview` HOMEp); a folder without one stays name-only.
        headerSubtitle: phoneHead ? undefined : params.workspaceRef?.repositoryIdentity?.repository,
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
        headerRight: () => {
            const launchers: ProjectHeaderActionsProps = {
                testIdPrefix: params.testIdPrefix,
                showWorktreesButton: params.showWorktreesButton,
                showWorkspaceExperienceButton: params.showWorkspaceExperienceButton,
                workspaceExperienceToggleA11yLabel: params.workspaceExperienceToggleA11yLabel,
                onToggleWorkspaceExperience: params.onToggleWorkspaceExperience,
                onOpenWorktrees: params.onToggleWorktrees,
                onOpenBrowser: barHoldsTools ? undefined : params.onOpenBrowser,
                onOpenTerminal: barHoldsTools ? undefined : params.onOpenTerminal,
            };
            return phoneHead ? phoneHead(launchers) : <ProjectHeaderActions {...launchers} />;
        },
        } : {}),
    }), [
        phoneBar,
        barHoldsTools,
        handleBack,
        params.activeRootPath,
        params.onBack,
        params.onOpenBrowser,
        params.onOpenTerminal,
        params.onToggleWorkspaceExperience,
        params.onToggleWorktrees,
        phoneHead,
        params.showWorktreesButton,
        params.showWorkspaceExperienceButton,
        params.testIdPrefix,
        params.workspaceRef,
        params.workspaceExperienceToggleA11yLabel,
        theme.colors.chrome.header.background,
        theme.colors.chrome.header.foreground,
    ]);
}
