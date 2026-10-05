import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

export const embeddedTerminalPaneStyles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
    toolbar: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.inset, 'content', true),
        gap: 10,
    },
    toolbarLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
        flex: 1,
    },
    toolbarTitle: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    toolbarRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    banner: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
    },
    bannerUrl: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    bannerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    terminalSurface: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        padding: 8,
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'content', true),
        opacity: 0.96,
    },
}));
