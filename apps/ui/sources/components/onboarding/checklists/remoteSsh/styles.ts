import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const remoteSshChecklistStyles = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: theme.space.s16,
    },
    heading: {
        gap: theme.space.s6,
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
    // A field's label over its control, the form's 6 px (lab direction A rhythm 6 / 16 / 24).
    fieldBlock: {
        width: '100%',
        gap: theme.space.s6,
    },
    promptCard: {
        width: '100%',
        gap: theme.space.s10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.modal,
        padding: theme.space.s20,
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
        gap: theme.space.s10,
    },
    toggleListItem: {
        width: '100%',
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    toggleListItemTitle: {
        color: theme.colors.text.primary,
    },
    toggleListItemSubtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
