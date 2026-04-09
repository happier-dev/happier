import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isRenderableElementType } from '@/components/ui/icons/isRenderableElementType';
import { ResizableDockedPane } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { resolveViewportMinEdgePx, VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from '@/utils/platform/viewportClass';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';

import { SettingsSidebar } from '@/components/settings/shell/SettingsSidebar';
import {
    SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX,
    SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX,
    SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX,
} from './settingsSidebarSizing';

class SettingsShellSidebarCrashBoundary extends React.Component<
    Readonly<{
        onSidebarError: () => void;
        children: React.ReactNode;
    }>,
    Readonly<{ hasError: boolean }>
> {
    public state = { hasError: false } as const;
    private didHandleError = false;

    public static getDerivedStateFromError(): Readonly<{ hasError: boolean }> {
        return { hasError: true };
    }

    public componentDidCatch() {
        if (this.didHandleError) return;
        this.didHandleError = true;
        try {
            this.props.onSidebarError();
        } catch {
            // Never allow the crash boundary itself to trigger the global crash screen.
        }
    }

    public render() {
        if (this.state.hasError) return null;
        return this.props.children;
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface,
    },
    row: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    content: {
        flex: 1,
        minHeight: 0,
    },
}));

export const SettingsShell = React.memo(function SettingsShell(props: Readonly<{ children: React.ReactNode }>) {
    const styles = stylesheet;
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const { theme } = useUnistyles();

    const settingsNavSidebarEnabled = useLocalSetting('settingsNavSidebarEnabled');
    const isTabletViewport = resolveViewportMinEdgePx({ width: windowWidth, height: windowHeight }) >= VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin;
    const enabled = isTabletViewport && settingsNavSidebarEnabled !== false;
    const [sidebarFallbackActive, setSidebarFallbackActive] = React.useState(false);
    const sidebarWidthPx = useLocalSetting('settingsNavSidebarWidthPx') ?? SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX;
    const sidebarWidthBasisPx = useLocalSetting('settingsNavSidebarWidthBasisPx') ?? windowWidth;
    const [, setSidebarWidthPx] = useLocalSettingMutable('settingsNavSidebarWidthPx');
    const [, setSidebarWidthBasisPx] = useLocalSettingMutable('settingsNavSidebarWidthBasisPx');
    const preferredSidebarWidthPx = typeof sidebarWidthPx === 'number' ? sidebarWidthPx : SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX;
    const basisSidebarWidthPx = typeof sidebarWidthBasisPx === 'number' ? sidebarWidthBasisPx : windowWidth;

    const effectiveSidebarWidthPx = React.useMemo(() => {
        return resolveScaledPaneWidthPx({
            preferredWidthPx: preferredSidebarWidthPx,
            basisContainerWidthPx: basisSidebarWidthPx,
            containerWidthPx: windowWidth,
            minPx: SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX,
            maxPx: SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX,
            skipScalingWhenPreferredWidthPxMatches: SETTINGS_NAV_SIDEBAR_DEFAULT_WIDTH_PX,
        });
    }, [basisSidebarWidthPx, preferredSidebarWidthPx, windowWidth]);

    React.useEffect(() => {
        if (!enabled && sidebarFallbackActive) {
            setSidebarFallbackActive(false);
        }
    }, [enabled, sidebarFallbackActive]);

    const handleSidebarRenderError = React.useCallback(() => {
        setSidebarFallbackActive(true);
    }, []);

    const ResizableDockedPaneComponent = isRenderableElementType(ResizableDockedPane) ? ResizableDockedPane : null;
    const SettingsSidebarComponent = isRenderableElementType(SettingsSidebar) ? SettingsSidebar : null;

    if (!enabled || sidebarFallbackActive || !ResizableDockedPaneComponent || !SettingsSidebarComponent) {
        return <View style={styles.root}>{props.children}</View>;
    }

    return (
        <View style={styles.root}>
            <View style={styles.row}>
                <View style={styles.content}>
                    {props.children}
                </View>

                <SettingsShellSidebarCrashBoundary onSidebarError={handleSidebarRenderError}>
                    <ResizableDockedPaneComponent
                        testID="settings-shell.sidebarPane"
                        widthPx={effectiveSidebarWidthPx}
                        minWidthPx={SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX}
                        maxWidthPx={SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX}
                        resizeEdge="left"
                        onCommitWidthPx={(nextWidthPx) => {
                            setSidebarWidthPx(nextWidthPx);
                            setSidebarWidthBasisPx(windowWidth);
                        }}
                    >
                        <View style={{ flex: 1, minHeight: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.divider }}>
                            <SettingsSidebarComponent />
                        </View>
                    </ResizableDockedPaneComponent>
                </SettingsShellSidebarCrashBoundary>
            </View>
        </View>
    );
});
