import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const onboardingWizardSurfaceStylesheet = StyleSheet.create((theme) => ({
    urlHint: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
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
