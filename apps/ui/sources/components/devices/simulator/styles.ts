import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

/**
 * The device viewer reads like the other live-picture viewers (Computer): a bar that names the
 * device and its state, the screen on an inset stage as the main content, the common device actions
 * on a rail beside it, and rare tools one press away in a side panel.
 */
export const simulatorStreamStyles = StyleSheet.create((theme) => ({
    paneRoot: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minHeight: 44,
        paddingLeft: 14,
        paddingRight: theme.space.s6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    barStacked: {
        gap: theme.space.s2,
        paddingLeft: 14,
        paddingRight: theme.space.s6,
        paddingVertical: theme.space.s4,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    barRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s10,
        minHeight: 36,
    },
    barIdentity: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    barTitle: {
        ...Typography.variant('label', 'semiBold'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    barMeta: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    barStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
        minWidth: 0,
    },
    barActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    content: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
    },
    contentStacked: {
        flexDirection: 'column',
    },
    stage: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: theme.colors.surface.inset,
    },
    fill: {
        ...StyleSheet.absoluteFillObject,
    },
    hidden: {
        display: 'none',
    },
    inputLayer: {
        flex: 1,
        minHeight: 0,
    },
    // A state that is not a picture is centred while it fits and reads from its top while it does not.
    stateStage: {
        flex: 1,
        minHeight: 0,
    },
    stateStageContent: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    // The last picture stays, dimmed, while the stream reconnects: never a blank box.
    heldScrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.overlay.scrimSoft,
        pointerEvents: 'none',
    },
    showControls: {
        position: 'absolute',
        top: theme.space.s8,
        right: theme.space.s8,
    },
    rail: {
        alignItems: 'center',
        gap: theme.space.s8,
        paddingVertical: theme.space.s10,
        paddingHorizontal: theme.space.s6,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.subtle,
    },
    railHorizontal: {
        flexDirection: 'row',
        justifyContent: 'center',
        paddingVertical: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        borderLeftWidth: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    railDivider: {
        alignSelf: 'stretch',
        height: StyleSheet.hairlineWidth,
        marginVertical: theme.space.s2,
        backgroundColor: theme.colors.border.subtle,
    },
    railDividerHorizontal: {
        width: StyleSheet.hairlineWidth,
        height: 'auto',
        marginVertical: 0,
        marginHorizontal: theme.space.s2,
    },
    tools: {
        width: 260,
        maxWidth: 320,
        minHeight: 0,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
    toolsStacked: {
        flex: 1,
        width: 'auto',
        maxWidth: undefined,
        borderLeftWidth: 0,
    },
    toolsHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 44,
        paddingLeft: 14,
        paddingRight: theme.space.s6,
    },
    toolsTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    toolsBody: {
        paddingBottom: theme.space.s16,
    },
}));
