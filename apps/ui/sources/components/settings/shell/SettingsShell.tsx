import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isRenderableElementType } from '@/components/ui/icons/isRenderableElementType';
import { ResizableDockedPane } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { resolveViewportMinEdgePx, VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from '@/utils/platform/viewportClass';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';

import { SettingsSidebar } from '@/components/settings/shell/SettingsSidebar';
import { SettingsModalFloatingControls } from '@/components/settings/shell/SettingsModalFloatingControls';
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
        // The plane the content pane lies on: the content pane is transparent and each settings
        // route paints its own canvas through `ItemList`. The rail beside it is the raised
        // surface, so this canvas is the recessed field the rail sits proud of.
        backgroundColor: theme.colors.background.canvas,
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

/**
 * There is deliberately no seam-cast shadow here. The rail is the raised plane and the content
 * pane the recessed one, so a leftward cast from the content onto the rail would light the seam
 * backwards. The rail's own hairline carries the separation on every platform — a hairline is
 * also the more restrained separator between a white rail and a grey content field.
 */

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

    const showRail = enabled && !sidebarFallbackActive && !!ResizableDockedPaneComponent && !!SettingsSidebarComponent;

    // Phone / non-modal: the navigator header still provides chrome, so render content
    // full-screen with no floating controls.
    if (!isTabletViewport) {
        return <View style={styles.root}>{props.children}</View>;
    }

    // Modal mode (tablet/desktop): the navigator header is removed, so the content pane
    // carries floating close/back controls above the scrollable content.
    const contentPane = (
        <View style={styles.content}>
            {props.children}
            <SettingsModalFloatingControls />
        </View>
    );

    if (!showRail) {
        return <View style={styles.root}>{contentPane}</View>;
    }

    return (
        <View style={styles.root}>
            <View style={styles.row}>
                <SettingsShellSidebarCrashBoundary onSidebarError={handleSidebarRenderError}>
                    <ResizableDockedPaneComponent
                        testID="settings-shell.sidebarPane"
                        widthPx={effectiveSidebarWidthPx}
                        minWidthPx={SETTINGS_NAV_SIDEBAR_MIN_WIDTH_PX}
                        maxWidthPx={SETTINGS_NAV_SIDEBAR_MAX_WIDTH_PX}
                        resizeEdge="right"
                        onCommitWidthPx={(nextWidthPx) => {
                            setSidebarWidthPx(nextWidthPx);
                            setSidebarWidthBasisPx(windowWidth);
                        }}
                    >
                        <View style={{ flex: 1, minHeight: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.border.default }}>
                            <SettingsSidebarComponent />
                        </View>
                    </ResizableDockedPaneComponent>
                </SettingsShellSidebarCrashBoundary>

                {contentPane}
            </View>
        </View>
    );
});
