import { StyleSheet } from 'react-native-unistyles';

/**
 * Layout for the session instrument strip. One 28-high row: connection/working
 * status pinned left, a flexible spacer, then the right-aligned instrument
 * cluster (context gauge · quota ring · git ± · extension badges · permission).
 */
export const instrumentStripStyles = StyleSheet.create((theme) => ({
    root: {
        minHeight: 28,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 4,
    },
    connectionGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: 6,
    },
    connectionDot: {
        marginRight: 0,
    },
    connectionText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    spacer: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 8,
    },
    cluster: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: 10,
    },
    instrumentSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    instrumentValueText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    permissionChip: {
        flexShrink: 0,
    },
    permissionText: {
        fontSize: 12,
        fontVariant: ['tabular-nums'],
    },
    overflowChip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 20,
        minWidth: 28,
        paddingHorizontal: 6,
        borderRadius: 999,
    },
    overflowChipText: {
        fontSize: 13,
        lineHeight: 13,
        color: theme.colors.text.secondary,
    },
    overflowPopover: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 14,
        minWidth: 220,
    },
    overflowPopoverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    overflowPopoverRowLabel: {
        fontSize: 13,
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
}));
