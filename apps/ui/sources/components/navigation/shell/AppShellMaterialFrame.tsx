import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { glassSurfaceBackgroundColor, glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { useGlassMaterialColorResolver } from '@/components/ui/glass/useGlassSurfaceColor';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';
import { appShellColumnSurface } from './appRail/appShellColumnSurface';
import { APP_RAIL_WIDTH_PX } from './appRail/appRailMetrics';

/**
 * The sheet that holds the column and the page lies on the window's canvas, inset from the window's
 * right and bottom edges with rounded corners, the rail and title strip around it (lab `xrail-R1`).
 */
const CONTENT_SHEET_RADIUS_PX = 12;
const CONTENT_SHEET_WINDOW_INSET_PX = 8;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    body: {
        flexDirection: 'row',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    chromePlane: {
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    bottomChrome: {
        position: 'absolute',
        left: APP_RAIL_WIDTH_PX,
        right: 0,
        bottom: 0,
        height: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    rightChrome: {
        position: 'absolute',
        top: 0,
        bottom: CONTENT_SHEET_WINDOW_INSET_PX,
        right: 0,
        width: CONTENT_SHEET_WINDOW_INSET_PX,
        ...glassSurfacePlaneStyle(theme.colors.background.canvas, 'chrome'),
    },
    content: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    contentPlane: {
        ...glassSurfacePlaneStyle(theme.colors.surface.base, 'content'),
    },
    contentSheet: {
        flexDirection: 'row',
        marginRight: CONTENT_SHEET_WINDOW_INSET_PX,
        marginBottom: CONTENT_SHEET_WINDOW_INSET_PX,
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    /**
     * The seam shadow. An inert overlay tracing the content sheet's exact footprint — same left
     * corners, transparent fill — whose only job is to cast the sheet's lift shadow leftward onto
     * the sidebar.
     *
     * It stays separate from the clipped content sheet so the shadow reaches the sidebar.
     * Its rounded shape keeps the cast aligned with the sheet's corners.
     */
    contentSheetSeamShadow: {
        position: 'absolute',
        top: 0,
        bottom: CONTENT_SHEET_WINDOW_INSET_PX,
        right: CONTENT_SHEET_WINDOW_INSET_PX,
        borderRadius: CONTENT_SHEET_RADIUS_PX,
        zIndex: 2,
        boxShadow: theme.colors.shadowSeamCastBoxShadow,
    },
}));

/** Web window planes keep their tint-only paint; native planes use the same tier owner as overlays. */
export function AppShellMaterialPlane(props: Readonly<{
    group: GlassSurfaceGroup;
    color: string;
    translucentColor: string;
    style: StyleProp<ViewStyle>;
    testID?: string;
    pointerEvents?: 'none';
    nested?: boolean;
    children?: React.ReactNode;
}>) {
    const resolveMaterialColor = useGlassMaterialColorResolver(props.group);
    if (Platform.OS !== 'web') {
        if (props.pointerEvents === 'none') return <View pointerEvents="none" style={[props.style, { backgroundColor: 'transparent' }]}>
            <GlassSurface surfaceGroup={props.group} solidColor={props.color} finishRole={null} nested={props.nested} style={StyleSheet.absoluteFillObject}>
                {props.children}
            </GlassSurface>
        </View>;
        return <GlassSurface testID={props.testID} surfaceGroup={props.group} solidColor={props.color} finishRole={null} nested={props.nested} style={props.style}>
            {props.children}
        </GlassSurface>;
    }
    return <HappierMaterialRoleProvider role={props.group} translucentColor={props.translucentColor} resolveMaterialColor={resolveMaterialColor}>
        <View testID={props.testID} pointerEvents={props.pointerEvents} style={[props.style, { backgroundColor: glassSurfaceBackgroundColor(props.color, props.group, props.nested) }]}>{props.children}</View>
    </HappierMaterialRoleProvider>;
}


/** Paint and geometry for the real shell, independent of navigation/settings subscriptions. */
export function AppShellMaterialFrame(props: Readonly<{
    showChrome: boolean;
    dragEnabled: boolean;
    leftOffsetPx: number;
    sidebarWidth: number;
    titleStrip: React.ReactNode;
    rail: React.ReactNode;
    column: React.ReactNode;
    peek: React.ReactNode;
    children: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return <DesktopMainContentDragSurface enabled={props.dragEnabled} leftOffsetPx={props.leftOffsetPx}
        style={styles.root}>
        {props.titleStrip ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={styles.chromePlane}>
            {props.titleStrip}
        </AppShellMaterialPlane> : null}
        <View key="shell-body" style={styles.body}>
            {props.showChrome ? <>
                <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} pointerEvents="none" style={styles.bottomChrome} />
                <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} pointerEvents="none" style={styles.rightChrome} />
            </> : null}
            {props.rail ? <AppShellMaterialPlane group="chrome" color={theme.colors.background.canvas} translucentColor={theme.colors.surface.selected} style={[styles.chromePlane, { width: APP_RAIL_WIDTH_PX, flexShrink: 0 }]}>
                {props.rail}
            </AppShellMaterialPlane> : null}
            <View key="sheet" style={[styles.content, props.showChrome && styles.contentSheet]}>
                {props.column ? <AppShellMaterialPlane key="column" testID="navigation-sidebar" group="sidebar" color={theme.colors.surface.inset}
                    translucentColor={theme.colors.surface.selected} style={[appShellColumnSurface.column, { width: props.sidebarWidth }]}>
                    {props.column}
                </AppShellMaterialPlane> : null}
                <AppShellMaterialPlane key="route-content" group="content" color={theme.colors.surface.base} translucentColor={theme.colors.surface.selected} style={[styles.content, styles.contentPlane]}>
                    {props.children}
                </AppShellMaterialPlane>
                {props.peek}
            </View>
            {Platform.OS === 'web' && props.showChrome ? <View pointerEvents="none"
                style={[styles.contentSheetSeamShadow, { left: APP_RAIL_WIDTH_PX }]} /> : null}
        </View>
    </DesktopMainContentDragSurface>;
}
