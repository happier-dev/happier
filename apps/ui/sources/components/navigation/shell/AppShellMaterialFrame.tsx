import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';
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
    return <DesktopMainContentDragSurface enabled={props.dragEnabled} leftOffsetPx={props.leftOffsetPx}
        style={styles.root}>
        {props.titleStrip ? <View style={styles.chromePlane}>{props.titleStrip}</View> : null}
        <View key="shell-body" style={styles.body}>
            {props.showChrome ? <>
                <View pointerEvents="none" style={styles.bottomChrome} />
                <View pointerEvents="none" style={styles.rightChrome} />
            </> : null}
            {props.rail ? <View style={[styles.chromePlane, { width: APP_RAIL_WIDTH_PX, flexShrink: 0 }]}>{props.rail}</View> : null}
            <View key="sheet" style={[styles.content, props.showChrome && styles.contentSheet]}>
                {props.column ? <View key="column" testID="navigation-sidebar" style={[appShellColumnSurface.column, { width: props.sidebarWidth }]}>
                    {props.column}
                </View> : null}
                <View key="route-content" style={[styles.content, styles.contentPlane]}>{props.children}</View>
                {props.peek}
            </View>
            {Platform.OS === 'web' && props.showChrome ? <View pointerEvents="none"
                style={[styles.contentSheetSeamShadow, { left: APP_RAIL_WIDTH_PX }]} /> : null}
        </View>
    </DesktopMainContentDragSurface>;
}
