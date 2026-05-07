import { useLocalSettingMutable, useSetting } from '@/sync/domains/state/storage';
import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';
import { MainView } from './MainView';
import { StyleSheet } from 'react-native-unistyles';
import { PopoverScope } from '@/components/ui/popover';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { config } from '@/config';
import { isStackContext } from '@/sync/domains/server/serverContext';
import { isUsingCustomServer } from '@/sync/domains/server/serverConfig';
import { resolveVisibleAppEnvironmentBadge } from '@/sync/runtime/appVariant';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { DesktopSidebarChrome } from './desktopChrome/DesktopSidebarChrome';
import { useResolvedDesktopWindowControls } from './desktopChrome/useResolvedDesktopWindowControls';
import { useDesktopSidebarHistoryNavigationAvailability } from './desktopChrome/useDesktopSidebarHistoryNavigationAvailability';
import { useSidebarHeaderActions } from './desktopChrome/useSidebarHeaderActions';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';

export type SidebarViewProps = Readonly<{
    sidebarWidthPx?: number | null;
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'visible',
    },
}));

export const SidebarView = React.memo((props: SidebarViewProps) => {
    const styles = stylesheet;
    const safeArea = useChromeSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const popoverBoundaryRef = React.useRef<any>(null);
    const showEnvironmentBadge = useSetting('showEnvironmentBadge');
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const voiceEnabled = useFeatureEnabled('voice');
    const { headerActions, topUtilityActions, renderHeaderOverflowVisual } = useSidebarHeaderActions();
    const navigationAvailability = useDesktopSidebarHistoryNavigationAvailability();
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'expanded',
        desktopWindowControls: props.desktopWindowControls,
        hasDesktopWindowControlsOverride: Object.prototype.hasOwnProperty.call(props, 'desktopWindowControls'),
    });
    const environmentBadge = resolveVisibleAppEnvironmentBadge({
        showEnvironmentBadge,
        appVariant: config.variant,
        envAppEnv: process.env.APP_ENV,
        envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
        isStackContext: isStackContext(),
        isUsingCustomServer: isUsingCustomServer(),
    });

    const handleHome = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) {
            fireAndForget(result, { tag: 'SidebarView.nav.home' });
        }
    }, [router]);

    const handleCollapseSidebar = React.useCallback(() => {
        setSidebarCollapsed(true);
    }, [setSidebarCollapsed]);

    const handleNavigateBack = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.back());
        if (result !== true) {
            fireAndForget(result, { tag: 'SidebarView.nav.back' });
        }
    }, [router]);

    const handleNavigateForward = React.useCallback(() => {
        const result = runGuardedNavigation(() => {
            const historyLike = (globalThis as { history?: { forward?: () => void } }).history;
            historyLike?.forward?.();
        });
        if (result !== true) {
            fireAndForget(result, { tag: 'SidebarView.nav.forward' });
        }
    }, []);

    return (
        <View testID="sidebar-view" ref={popoverBoundaryRef} style={[styles.container, { paddingTop: safeArea.top }]}>
            <PopoverScope boundaryRef={popoverBoundaryRef}>
                <DesktopSidebarChrome
                    sidebarWidthPx={props.sidebarWidthPx ?? null}
                    headerHeightPx={headerHeight}
                    onPressHome={handleHome}
                    onPressCollapse={handleCollapseSidebar}
                    onPressBack={handleNavigateBack}
                    onPressForward={handleNavigateForward}
                    canNavigateBack={navigationAvailability.canNavigateBack}
                    canNavigateForward={navigationAvailability.canNavigateForward}
                    environmentBadge={environmentBadge}
                    headerActions={headerActions}
                    topUtilityActions={topUtilityActions}
                    renderHeaderOverflowVisual={renderHeaderOverflowVisual}
                    popoverBoundaryRef={popoverBoundaryRef}
                    desktopWindowControls={resolvedDesktopWindowControls}
                    desktopUpdateIndicator={props.desktopUpdateIndicator}
                />
                {voiceEnabled ? <VoiceSurface variant="sidebar" /> : null}
                <MainView variant="sidebar" />
            </PopoverScope>
        </View>
    );
});
