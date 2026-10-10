import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useContainingHappierMaterialRole, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { AppShellMaterialPlane } from '@/components/navigation/shell/AppShellMaterialFrame';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { appShellColumnSurface } from '@/components/navigation/shell/appRail/appShellColumnSurface';
import { isRenderableElementType } from '@/components/ui/icons/isRenderableElementType';
import { ResizableDockedPane } from '@/components/ui/panels/ResizableDockedPane';
import { resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { resolveViewportMinEdgePx, VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from '@/utils/platform/viewportClass';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';

import { SettingsSidebar } from '@/components/settings/shell/SettingsSidebar';
import { SettingsPageSearchProvider } from './SettingsPageSearchContext';
import { SettingsFloatingControlsHost } from '@/components/settings/shell/SettingsModalFloatingControls';
import { SettingsRailVisibilityContext } from '@/components/settings/shell/settingsRailVisibility';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
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
    // Outside the app shell this shell owns the navigation column, so it paints the column's plane
    // (`appShellColumnSurface`); the navigation list inside paints nothing.
    sidebarColumn: {
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
    const hosted = useDestinationInstanceKey() !== null;
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const containingMaterial = useContainingHappierMaterialRole();
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
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

    // Beside the app rail, the settings navigation is the app shell's column (a destination, not a
    // modal): this shell then hosts the page only, and never draws a second copy of the navigation.
    const appShell = useAppShellColumn();
    const showRail = enabled && !appShell.present && !sidebarFallbackActive && !!ResizableDockedPaneComponent && !!SettingsSidebarComponent;

    // Keep the nested navigator under the same wrappers and at the same sibling
    // position. Replacing this tree on resize resets its route and unsaved forms.
    return (
        <SettingsPageSearchProvider>
        <View style={[styles.root, { backgroundColor: materialColor(theme.colors.background.canvas, 'transparent') }]}>
            <View style={styles.row}>
                {showRail ? <SettingsShellSidebarCrashBoundary onSidebarError={handleSidebarRenderError}>
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
                        <AppShellMaterialPlane group="sidebar" color={theme.colors.surface.inset} translucentColor={theme.colors.surface.selected} style={[appShellColumnSurface.column, styles.sidebarColumn]}>
                            <SettingsSidebarComponent />
                        </AppShellMaterialPlane>
                    </ResizableDockedPaneComponent>
                </SettingsShellSidebarCrashBoundary> : null}

                <AppShellMaterialPlane group="content" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} nested={containingMaterial !== undefined} style={styles.content}>
                    <SettingsRailVisibilityContext.Provider value={showRail || appShell.columnVisible}>
                        <SettingsFloatingControlsHost enabled={isTabletViewport || hosted}>
                            {props.children}
                        </SettingsFloatingControlsHost>
                    </SettingsRailVisibilityContext.Provider>
                </AppShellMaterialPlane>
            </View>
        </View>
        </SettingsPageSearchProvider>
    );
});
