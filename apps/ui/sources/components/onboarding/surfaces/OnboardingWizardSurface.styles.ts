import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

export const onboardingWizardSurfaceStylesheet = StyleSheet.create((theme) => ({
    urlBlock: {
        width: '100%',
        gap: 12,
    },
    urlInput: {
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 14,
        paddingHorizontal: 16,
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
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    confirmRelayLockText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.state.warning.foreground,
    },
    relayHintBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        flexDirection: 'row',
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: theme.colors.surface.selected,
        borderRadius: 999,
    },
    relayHintLine: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    relayHintIcon: {
        color: theme.colors.text.secondary,
    },
    relayGroupTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
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
        maxWidth: 480,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
    },
    relaySelectRouteContent: {
        width: '100%',
        gap: 24,
    },
    labelContainer: {
    },
    label: {
        fontSize: 16,
        textAlign: 'center',
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));

export type OnboardingWizardSurfaceStyles = typeof onboardingWizardSurfaceStylesheet;
