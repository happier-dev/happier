import { type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT,
    PET_COMPANION_ACTIVITY_TRAY_WIDTH,
} from './petCompanionActivityTrayGeometry';

export const styles = StyleSheet.create({
    root: {
        width: PET_COMPANION_ACTIVITY_TRAY_WIDTH,
        maxWidth: PET_COMPANION_ACTIVITY_TRAY_WIDTH,
        maxHeight: PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT,
        gap: 4,
        alignItems: 'flex-end',
        overflow: 'hidden',
        position: 'relative',
    } satisfies ViewStyle,
    scroll: {
        width: PET_COMPANION_ACTIVITY_TRAY_WIDTH,
        maxHeight: PET_COMPANION_ACTIVITY_TRAY_MAX_HEIGHT,
    } satisfies ViewStyle,
    scrollContent: {
        gap: 4,
        alignItems: 'flex-end',
    } satisfies ViewStyle,
    rootOpen: {
        opacity: 1,
        transform: [
            { translateY: 0 },
            { scale: 1 },
        ],
    },
    rootCollapsed: {
        opacity: 0,
        transform: [
            { translateY: 8 },
            { scale: 0.96 },
        ],
    },
    item: {
        width: PET_COMPANION_ACTIVITY_TRAY_WIDTH,
        borderRadius: 14,
        borderWidth: 0,
        paddingHorizontal: 14,
        paddingVertical: 8,
        gap: 0,
        position: 'relative',
        overflow: 'hidden',
        elevation: 0,
        shadowOpacity: 0,
    } satisfies ViewStyle,
    itemSurface: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        borderRadius: 14,
        borderWidth: 0,
        zIndex: 0,
    } satisfies ViewStyle,
    itemReplyOpen: {} satisfies ViewStyle,
    rowReverse: {
        flexDirection: 'row-reverse',
    },
    statusBadge: {
        position: 'absolute',
        top: 8,
        right: 10,
        width: 14,
        height: 14,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 0,
        borderRadius: 0,
        zIndex: 2,
    },
    iconButton: {
        position: 'absolute',
        top: 4,
        left: 4,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2,
    },
    iconButtonRtl: {
        right: 4,
        left: undefined,
    },
    hiddenAction: {
        opacity: 0,
    },
    visibleAction: {
        opacity: 1,
    },
    copy: {
        gap: 1,
        minWidth: 0,
        paddingRight: 66,
        zIndex: 1,
    },
    title: {
        fontSize: 14,
        lineHeight: 17,
        fontWeight: '600',
    },
    subtitle: {
        fontSize: 12,
        lineHeight: 15,
    },
    replyAction: {
        position: 'absolute',
        right: 8,
        bottom: 6,
        minWidth: 50,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 10,
        zIndex: 2,
    },
    replyActionText: {
        fontSize: 12,
        fontWeight: '600',
    },
    replyRow: {
        flexDirection: 'row',
        alignItems: 'center',
        overflow: 'hidden',
    },
    replyRowCollapsed: {
        opacity: 0,
        maxHeight: 0,
    },
    replyRowExpanded: {
        opacity: 1,
        marginTop: 8,
        maxHeight: 40,
    },
    replyInputShell: {
        flex: 1,
        minWidth: 0,
        minHeight: 30,
        position: 'relative',
    },
    replyInput: {
        width: '100%',
        minHeight: 30,
        borderWidth: 1,
        borderRadius: 16,
        paddingLeft: 12,
        paddingRight: 40,
        paddingTop: 5,
        paddingBottom: 4,
        fontSize: 13,
        lineHeight: 17,
    },
    replyInputRtl: {
        paddingRight: 12,
        paddingLeft: 40,
    },
    sendButton: {
        position: 'absolute',
        right: 3,
        top: 1,
        width: 28,
        height: 28,
        borderRadius: 14,
        borderWidth: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonRtl: {
        right: undefined,
        left: 2,
    },
});
