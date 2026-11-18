import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const onboardingWizardSurfaceStylesheet = StyleSheet.create((theme) => ({
    urlBlock: {
        width: '100%',
        gap: theme.space.s12,
    },
    urlInput: {
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        color: theme.colors.text.primary,
        fontSize: 16,
        lineHeight: 22,
    },
    urlHint: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
    },
    confirmRelayLockCard: {
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.state.warning.border,
        backgroundColor: theme.colors.state.warning.background,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
    },
    confirmRelayLockText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.state.warning.textForeground,
    },
    relayGroupTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
        textAlign: 'left',
        marginBottom: theme.space.s6,
    },
    scanCtaBlock: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'flex-start',
    },
    authEntryWrapper: {
        width: '100%',
        alignItems: 'stretch',
    },
    relaySelectRouteContent: {
        width: '100%',
        gap: 18,
    },
}));

export type OnboardingWizardSurfaceStyles = typeof onboardingWizardSurfaceStylesheet;
