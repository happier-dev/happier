import { Typography } from '@/constants/Typography';
import { layout } from '@/components/ui/layout/layout';
import { StyleSheet } from 'react-native-unistyles';

export const sessionListStyles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.background.canvas,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 14,
    },
    listHeaderSection: {
        backgroundColor: theme.colors.background.canvas,
    },
    headerText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    groupHeaderSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    groupHeaderTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    groupHeaderSubtitle: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        marginTop: 2,
        ...Typography.default(),
    },
    groupHeaderRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
    },
    groupHeaderTitleRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 6,
        flex: 1,
        minWidth: 0,
    },
    groupHeaderContent: {
        flex: 1,
        minWidth: 0,
    },
    groupHeaderInlineActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 2,
        flexShrink: 0,
    },
    groupHeaderTrailingActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        flexShrink: 0,
        marginLeft: 8,
    },
    groupHeaderActionButton: {
        width: 18,
        height: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 999,
        marginLeft: 4,
    },
    groupHeaderActionIcon: {
        color: theme.colors.text.secondary,
    },
    headerRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
    },
    headerLabelRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 4,
        flex: 1,
        minWidth: 0,
    },
    headerChevron: {
        width: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.text.secondary,
    },
    headerActionButton: {
        width: 18,
        height: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 999,
        marginLeft: 4,
    },
    groupHeaderChevron: {
        width: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.text.secondary,
    },
    webHoverHiddenChevron: {
        opacity: 0,
    },
    webHoverVisibleChevron: {
        opacity: 1,
    },
    footerContainer: {
        marginTop: -4,
    },
    dropIndicator: {
        position: 'absolute' as const,
        left: 16,
        right: 16,
        height: 2,
        borderRadius: 1,
        backgroundColor: theme.colors.accent.blue,
        zIndex: 10,
    },
}));
