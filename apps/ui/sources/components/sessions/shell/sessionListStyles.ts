import { Typography } from '@/constants/Typography';
import { layout } from '@/components/ui/layout/layout';
import { StyleSheet } from 'react-native-unistyles';

export const sessionListStyles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 18,
        paddingBottom: 6,
    },
    listHeaderSection: {
        backgroundColor: theme.colors.groupped.background,
        position: 'relative' as const,
    },
    listHeaderMenuAnchor: {
        position: 'absolute' as const,
        top: 8,
        right: 24,
        zIndex: 1,
    },
    listHeaderMenuButton: {
        width: 28,
        height: 28,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: -0.1,
        ...Typography.default('semiBold'),
    },
    groupHeaderSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    groupHeaderTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default('semiBold'),
    },
    groupHeaderSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
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
    },
    groupHeaderContent: {
        flex: 1,
        minWidth: 0,
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
        color: theme.colors.textSecondary,
    },
    headerRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
    },
    headerLabelRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 4,
    },
    headerChevron: {
        width: 18,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.textSecondary,
    },
    groupHeaderChevron: {
        width: 18,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.textSecondary,
    },
    webHoverHiddenChevron: {
        opacity: 0,
    },
    webHoverVisibleChevron: {
        opacity: 1,
    },
    footerContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    footerButton: {
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        alignSelf: 'stretch' as const,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 8,
        backgroundColor: theme.colors.surface,
    },
    footerButtonLabel: {
        fontSize: 13,
        color: theme.colors.text,
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
