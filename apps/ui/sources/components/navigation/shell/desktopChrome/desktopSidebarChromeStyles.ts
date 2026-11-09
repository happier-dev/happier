import { StyleSheet } from 'react-native-unistyles';
import {
    DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
    DESKTOP_WINDOW_CONTROLS_SLOT_MIN_WIDTH_PX,
} from './desktopChromeMetrics';

export const desktopSidebarChromeStyles = StyleSheet.create((theme) => ({
    windowControlsHost: {
        flexShrink: 0,
        minWidth: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_WIDTH_PX,
        alignItems: 'flex-start',
        justifyContent: 'center',
        position: 'relative',
        zIndex: 1,
    },
    updateIndicatorHost: {
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    windowControlsSlot: {
        minWidth: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_WIDTH_PX,
        minHeight: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
        position: 'relative',
        justifyContent: 'center',
    },
    windowControlsContent: {
        minHeight: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    windowDragRegion: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX / 2,
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -4,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: theme.space.s4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    windowControlsButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    windowControlsButtonsColumn: {
        flexDirection: 'column',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    windowControlsButton: {
        width: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
        height: DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
