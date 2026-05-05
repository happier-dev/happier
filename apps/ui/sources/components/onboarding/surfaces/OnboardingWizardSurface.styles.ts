import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const onboardingWizardSurfaceStylesheet = StyleSheet.create((theme) => ({
    urlBlock: {
        width: '100%',
        gap: 10,
    },
    urlInput: {
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: theme.colors.text,
    },
    urlHint: {
        color: theme.colors.textSecondary,
    },
    relayHintBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        flexDirection: 'row',
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: theme.colors.surfaceSelected,
        borderRadius: 999,
    },
    relayHintLine: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    relayHintIcon: {
        color: theme.colors.textSecondary,
    },
    relayGroupTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 6,
    },
    scanCtaBlock: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
    },
    welcomeHero: {
        width: '100%',
    },
    welcomeBody: {
        width: '100%',
        alignItems: 'center',
        gap: 10,
    },
    authEntryWrapper: {
        width: '100%',
        alignItems: 'center',
    },
    diagramContainer: {
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
    },
    labelContainer: {
    },
    label: {
        fontSize: 16,
        textAlign: 'center',
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
}));

export type OnboardingWizardSurfaceStyles = typeof onboardingWizardSurfaceStylesheet;
