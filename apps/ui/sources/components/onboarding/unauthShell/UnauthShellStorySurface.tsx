import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { UnauthenticatedSplitShell } from './UnauthenticatedSplitShell';

function FakeWelcomeDecision() {
    const { theme } = useUnistyles();
    return (
        <View style={styles.welcomeRoot}>
            <Text
                style={[styles.title, { color: theme.colors.text.primary }]}
                accessibilityRole="header"
            >
                {t('welcome.welcomeQuestionTitle')}
            </Text>
            <Text
                style={[styles.title, { color: theme.colors.text.tertiary }]}
                accessibilityRole="header"
            >
                {t('welcome.welcomeQuestionSubtitle')}
            </Text>
            <View style={styles.gap22} />
            <Text style={[styles.body, { color: theme.colors.text.secondary }]}>
                {t('welcome.welcomeQuestionBody')}
            </Text>
            <View style={styles.gap40} />
            <View style={[styles.primaryButton, { backgroundColor: theme.colors.button.primary.background }]}>
                <View style={styles.primaryButtonColumn}>
                    <Text style={[styles.primaryButtonLabel, { color: theme.colors.button.primary.tint }]}>
                        {t('welcome.welcomePrimaryButton')}
                    </Text>
                    <Text style={[styles.primaryButtonSubtitle, { color: theme.colors.button.primary.tint }]}>
                        {t('welcome.welcomePrimarySubtitle')}
                    </Text>
                </View>
                <Text style={[styles.primaryButtonArrow, { color: theme.colors.button.primary.tint }]}>→</Text>
            </View>
            <View style={styles.gap12} />
            <View style={[styles.secondaryButton, { borderColor: theme.colors.border.default }]}>
                <View style={styles.primaryButtonColumn}>
                    <Text style={[styles.secondaryButtonLabel, { color: theme.colors.text.primary }]}>
                        {t('welcome.welcomeSecondaryButton')}
                    </Text>
                    <Text style={[styles.secondaryButtonSubtitle, { color: theme.colors.text.secondary }]}>
                        {t('welcome.welcomeSecondarySubtitle')}
                    </Text>
                </View>
            </View>
        </View>
    );
}

function FakeRestoreStepBody() {
    const { theme } = useUnistyles();
    return (
        <View>
            <Text
                style={[styles.title, { fontSize: 30, lineHeight: 32, color: theme.colors.text.primary }]}
                accessibilityRole="header"
            >
                {t('setupOnboarding.preAuthTitle')}
            </Text>
            <View style={styles.gap22} />
            <Text style={[styles.body, { color: theme.colors.text.secondary }]}>
                {t('setupOnboarding.preAuthBody')}
            </Text>
        </View>
    );
}

/**
 * Dev-only preview of `UnauthenticatedSplitShell` in each layout mode. Not
 * mounted by any production route; lift it into a dev/QA screen
 * (`apps/ui/sources/app/dev/*`) when you need to inspect the shell without
 * running the full wizard.
 */
export function UnauthShellStorySurface() {
    return (
        <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.previewFrame}>
                <UnauthenticatedSplitShell
                    stepId="welcome"
                    isWelcomeStep
                    onOpenRelayCustomFlow={() => {}}
                    onBrandHeroGetStarted={() => {}}
                >
                    <FakeWelcomeDecision />
                </UnauthenticatedSplitShell>
            </View>

            <View style={styles.previewFrame}>
                <UnauthenticatedSplitShell
                    stepId="auth_restore"
                    isWelcomeStep={false}
                    onOpenRelayCustomFlow={() => {}}
                    onBrandHeroGetStarted={() => {}}
                    onBack={() => {}}
                >
                    <FakeRestoreStepBody />
                </UnauthenticatedSplitShell>
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create(() => ({
    scrollContent: {
        gap: 24,
        padding: 24,
    },
    previewFrame: {
        height: 720,
        borderRadius: 12,
        overflow: 'hidden',
    },
    welcomeRoot: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        lineHeight: 44,
        letterSpacing: -1.54,
    },
    body: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        maxWidth: 440,
    },
    gap12: { height: 12 },
    gap22: { height: 22 },
    gap40: { height: 40 },
    primaryButton: {
        height: 68,
        paddingHorizontal: 24,
        borderRadius: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    primaryButtonColumn: {
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
    },
    primaryButtonLabel: {
        ...Typography.default('semiBold'),
        fontSize: 17,
    },
    primaryButtonSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        opacity: 0.65,
    },
    primaryButtonArrow: {
        fontSize: 22,
    },
    secondaryButton: {
        height: 68,
        paddingHorizontal: 24,
        borderRadius: 14,
        borderWidth: 1,
        backgroundColor: 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    secondaryButtonLabel: {
        ...Typography.default('semiBold'),
        fontSize: 17,
    },
    secondaryButtonSubtitle: {
        ...Typography.default(),
        fontSize: 13,
    },
}));
