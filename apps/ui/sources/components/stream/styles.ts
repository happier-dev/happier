import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const streamPlayerStyles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    surface: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.inset,
    },
    frame: {
        width: '100%',
        height: '100%',
    },
    centered: {
        flex: 1,
        width: '100%',
        minHeight: 180,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 20,
    },
    titleText: {
        color: theme.colors.text.primary,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    metaText: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    overlay: {
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 12,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    statusPill: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    statusPillRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    statusText: {
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    controls: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        padding: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    controlButton: {
        minHeight: 32,
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    controlButtonDisabled: {
        backgroundColor: theme.colors.surface.base,
    },
    controlButtonText: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    controlButtonTextDisabled: {
        color: theme.colors.text.disabled,
    },
    statusDot: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusDotHalo: {
        position: 'absolute',
        width: 16,
        height: 16,
        borderRadius: 8,
        opacity: 0.28,
    },
}));
