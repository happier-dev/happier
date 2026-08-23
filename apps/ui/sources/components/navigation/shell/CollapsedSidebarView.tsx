import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { t } from '@/text';
import { SidebarExpandIcon } from './SidebarIcons';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { SidebarLogoButton } from './SidebarLogoButton';
import {
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX,
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
    DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
} from './desktopChrome/desktopChromeMetrics';
import { DesktopShellWindowControlsHost } from './desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from './desktopChrome/useResolvedDesktopWindowControls';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { AppUpdateStatusTagProps } from '@/components/ui/feedback/AppUpdateStatusTag';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
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

function renderUpdateIndicatorWithFallback(
    indicator: React.ReactNode,
    fallback: React.ReactNode,
): React.ReactNode {
    if (!indicator) {
        return fallback;
    }

    if (!React.isValidElement<AppUpdateStatusTagProps>(indicator)) {
        return indicator;
    }

    return React.cloneElement(indicator, {
        fallback,
        labelVariant: 'short',
    });
}

export type CollapsedSidebarViewProps = Readonly<{
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
    focusModeActive?: boolean;
    onExitFocusMode?: () => void;
    onRequestExpand?: () => void;
}>;

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

    const logoButton = (
        <SidebarLogoButton
            testID="collapsed-sidebar-home-button"
            onPress={handleHome}
            style={styles.logoButton}
        />
    );

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
                {renderUpdateIndicatorWithFallback(props.desktopUpdateIndicator, logoButton)}
                <ActionOperationActivityButton testID="collapsed-sidebar-action-operations" />
                {Platform.OS === 'web' ? (
                    <Pressable
                        testID="sidebar-expand-button"
                        onPress={handleExpand}
                        style={styles.button}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.expand')}
                    >
                        {/* The rail IS the collapsed state, so this button expands. It used to
                            take the collapse glyph and the component's default size, which made it
                            both the wrong icon and a different size from the same control in the
                            expanded chrome. */}
                        <SidebarExpandIcon
                            size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                            color={theme.colors.chrome.header.foreground}
                        />
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
});
