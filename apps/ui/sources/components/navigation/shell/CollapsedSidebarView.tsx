import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { t } from '@/text';
import { SidebarCollapseIcon } from './SidebarIcons';
import { SidebarLogoButton } from './SidebarLogoButton';
import {
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX,
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
} from './desktopChrome/desktopChromeMetrics';
import { DesktopShellUpdateIndicatorHost } from './desktopChrome/DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from './desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from './desktopChrome/useResolvedDesktopWindowControls';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type CollapsedSidebarViewProps = Readonly<{
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
    focusModeActive?: boolean;
    onExitFocusMode?: () => void;
    onRequestExpand?: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.divider,
        paddingHorizontal: DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX,
        gap: DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
    },
    chrome: {
        alignItems: 'center',
        gap: DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
        paddingTop: DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
    },
    controlsHost: {
        minWidth: 0,
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    controlsSlot: {
        minWidth: 0,
        alignSelf: 'stretch',
    },
    controlsContent: {
        justifyContent: 'center',
    },
    updateIndicatorHost: {
        alignSelf: 'stretch',
    },
    button: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 32,
    },
    logoButton: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 32,
    },
}));

export const CollapsedSidebarView = React.memo((props: CollapsedSidebarViewProps) => {
    const { focusModeActive = false, onExitFocusMode, onRequestExpand } = props;
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const router = useRouter();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { theme } = useUnistyles();
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'collapsed',
        desktopWindowControls: props.desktopWindowControls,
        hasDesktopWindowControlsOverride: Object.prototype.hasOwnProperty.call(props, 'desktopWindowControls'),
    });

    const handleExpand = React.useCallback(() => {
        if (onRequestExpand) {
            onRequestExpand();
            return;
        }
        setSidebarCollapsed(false);
    }, [onRequestExpand, setSidebarCollapsed]);

    const handleHome = React.useCallback(() => {
        if (focusModeActive) {
            onExitFocusMode?.();
        }
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) {
            fireAndForget(result, { tag: 'CollapsedSidebarView.nav.home' });
        }
    }, [focusModeActive, onExitFocusMode, router]);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top }]}>
            <View testID="desktop-collapsed-shell-chrome" style={[styles.chrome, { minHeight: headerHeight }]}>
                <DesktopShellWindowControlsHost
                    style={styles.controlsHost}
                    slotStyle={styles.controlsSlot}
                    contentStyle={styles.controlsContent}
                >
                    {resolvedDesktopWindowControls}
                </DesktopShellWindowControlsHost>
                <DesktopShellUpdateIndicatorHost style={styles.updateIndicatorHost}>
                    {props.desktopUpdateIndicator}
                </DesktopShellUpdateIndicatorHost>
                <SidebarLogoButton
                    testID="collapsed-sidebar-home-button"
                    onPress={handleHome}
                    style={styles.logoButton}
                />
                {Platform.OS === 'web' ? (
                    <Pressable
                        testID="sidebar-expand-button"
                        onPress={handleExpand}
                        style={styles.button}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.expand')}
                    >
                        <SidebarCollapseIcon color={theme.colors.header.tint} />
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
});
