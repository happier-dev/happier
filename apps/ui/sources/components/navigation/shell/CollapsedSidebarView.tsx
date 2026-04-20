import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { SidebarCollapseIcon } from './SidebarIcons';
import {
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX,
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
} from './desktopChrome/desktopChromeMetrics';
import { DesktopShellUpdateIndicatorHost } from './desktopChrome/DesktopShellUpdateIndicatorHost';
import { DesktopShellWindowControlsHost } from './desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from './desktopChrome/useResolvedDesktopWindowControls';

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
}));

export type CollapsedSidebarViewProps = Readonly<{
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
}>;

export const CollapsedSidebarView = React.memo((props: CollapsedSidebarViewProps) => {
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'collapsed',
        desktopWindowControls: props.desktopWindowControls,
        hasDesktopWindowControlsOverride: Object.prototype.hasOwnProperty.call(props, 'desktopWindowControls'),
    });

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
                {Platform.OS === 'web' ? (
                    <Pressable
                        testID="sidebar-expand-button"
                        onPress={() => setSidebarCollapsed(false)}
                        style={styles.button}
                        accessibilityRole="button"
                    >
                        <SidebarCollapseIcon />
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
});
