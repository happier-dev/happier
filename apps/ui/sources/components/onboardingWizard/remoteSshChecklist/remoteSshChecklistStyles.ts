import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const remoteSshChecklistStyles = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 16,
    },
    heading: {
        gap: 6,
        alignItems: 'center',
    },
    title: {
        color: theme.colors.text,
        textAlign: 'center',
    },
    subtitle: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    sectionBlock: {
        width: '100%',
        gap: 10,
    },
    promptCard: {
        width: '100%',
        gap: 10,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 16,
        backgroundColor: theme.colors.surface,
    },
    promptTitle: {
        color: theme.colors.text,
    },
    promptBody: {
        color: theme.colors.textSecondary,
    },
    toggleList: {
        width: '100%',
        gap: 10,
    },
    toggleListItem: {
        width: '100%',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    toggleListItemTitle: {
        color: theme.colors.text,
    },
    toggleListItemSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
}));
