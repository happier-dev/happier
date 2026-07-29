import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const remoteSshChecklistStyles = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 16,
    },
    heading: {
        gap: 6,
        alignItems: 'flex-start',
    },
    title: {
        color: theme.colors.text.primary,
        textAlign: 'left',
    },
    subtitle: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    sectionBlock: {
        width: '100%',
        gap: 10,
    },
    promptCard: {
        width: '100%',
        gap: 10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.modal,
        padding: 20,
        backgroundColor: theme.colors.surface.base,
    },
    promptTitle: {
        color: theme.colors.text.primary,
    },
    promptBody: {
        color: theme.colors.text.secondary,
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
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    toggleListItemTitle: {
        color: theme.colors.text.primary,
    },
    toggleListItemSubtitle: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
