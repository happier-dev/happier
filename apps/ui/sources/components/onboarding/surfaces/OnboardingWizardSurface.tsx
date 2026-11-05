import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { usePreventRemove } from '@react-navigation/native';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { StepTransitionFrame } from '@/components/ui/motion/StepTransitionFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { WizardLogotype } from '../ui/WizardLogotype';
import { WizardModalShell } from '../ui/WizardModalShell';
import {
    type OnboardingWizardController,
    type OnboardingWizardSurfaceProps,
} from './useOnboardingWizardController';

export type { OnboardingWizardSurfaceProps } from './useOnboardingWizardController';

export type OnboardingWizardSurfacePresentationProps = Readonly<OnboardingWizardSurfaceProps & {
    controller: OnboardingWizardController;
}>;

export function OnboardingWizardSurfacePresentation(props: OnboardingWizardSurfacePresentationProps) {
    const safeArea = useChromeSafeAreaInsets();
    const controller = props.controller;
    const testID = props.testID ?? 'onboarding-wizard';
    usePreventRemove(controller.navigationLocked, () => undefined);

    return (
        <View testID={props.wizardChromeMode === 'bare' ? testID : undefined} style={{ flex: 1, position: 'relative' }}>
            {props.shellChrome ? (
                <View
                    style={{
                        position: 'absolute',
                        top: safeArea.top + 12,
                        left: safeArea.left + 16,
                        zIndex: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                    }}
                    testID="desktop-unauth-shell-chrome"
                >
                    {props.shellChrome}
                </View>
            ) : null}
            {props.wizardChromeMode === 'bare' ? (
                <BareOnboardingWorkflowContent
                    controller={controller}
                    testID={testID}
                />
            ) : (
                <WizardModalShell
                    testID={testID}
                    stepIndex={controller.currentStepIndex}
                    stepCount={controller.stepCount}
                    contentTransitionKey={controller.stepId}
                    contentTransitionDirection={controller.contentTransitionDirection}
                    showScrim={props.wizardChromeMode === 'embedded' ? false : undefined}
                    layoutPresentation={props.wizardLayoutPresentation}
                    titleLeading={controller.stepId === 'welcome' ? <WizardLogotype height={45} testID={`${testID}-logotype`} /> : undefined}
                    title={controller.title}
                    subtitle={controller.subtitle ?? undefined}
                    onSkip={controller.onSkip ?? undefined}
                    skipLabel={controller.skipLabel ?? undefined}
                    skipDisabled={controller.skipDisabled}
                    onBack={controller.onBack ?? (() => {})}
                    backDisabled={controller.navigationLocked}
                    onPrimary={controller.onPrimary ?? undefined}
                    primaryLabel={controller.primaryLabel}
                    primaryDisabled={controller.primaryDisabled}
                    showBack={controller.showBack}
                    showSkip={controller.showSkip}
                    footerHint={controller.footerHint ?? undefined}
                >
                    {controller.body}
                </WizardModalShell>
            )}
        </View>
    );
}

type BareOnboardingWorkflowContentProps = Readonly<{
    controller: OnboardingWizardController;
    testID: string;
}>;

const bareStylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        width: '100%',
        maxWidth: 560,
        alignSelf: 'center',
        justifyContent: 'flex-start',
        gap: theme.space.s24,
    },
    content: {
        width: '100%',
        gap: theme.space.s10,
    },
    header: {
        width: '100%',
        gap: theme.space.s10,
    },
    title: {
        ...Typography.variant('display'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
    },
    body: {
        width: '100%',
        gap: theme.space.s24,
    },
    footer: {
        width: '100%',
        alignItems: 'flex-start',
        gap: 14,
    },
    footerHint: {
        alignItems: 'flex-start',
        justifyContent: 'center',
    },
    primaryButton: {
        width: '100%',
        maxWidth: 360,
    },
    // The quiet text button's own horizontal padding is pulled back so its label shares the
    // column's left edge with the Home chip and the fields above it.
    skipButton: {
        maxWidth: 360,
        marginLeft: -16,
    },
}));

function BareOnboardingWorkflowContent(props: BareOnboardingWorkflowContentProps) {
    useUnistyles();
    const styles = bareStylesheet;
    const controller = props.controller;

    if (controller.stepId === 'welcome') {
        return controller.body;
    }

    const canShowSkip = Boolean(controller.onSkip) && controller.showSkip !== false;
    const hasFooter = Boolean(controller.footerHint) || Boolean(controller.onPrimary) || canShowSkip;

    return (
        <View
            testID={`${props.testID}-bare-workflow`}
            style={styles.root}
        >
            <View style={styles.content}>
                <View style={styles.header}>
                    <Text
                        testID={`${props.testID}-bare-title`}
                        accessibilityRole="header"
                        style={styles.title}
                    >
                        {controller.title}
                    </Text>
                    {controller.subtitle ? (
                        <Text style={styles.subtitle}>
                            {controller.subtitle}
                        </Text>
                    ) : null}
                </View>
                <StepTransitionFrame
                    transitionKey={controller.stepId}
                    direction={controller.contentTransitionDirection}
                    testID={`${props.testID}-bare-body-transition`}
                >
                    <View style={styles.body}>
                        {controller.body}
                    </View>
                </StepTransitionFrame>
            </View>
            {hasFooter ? (
                <View style={styles.footer}>
                    {controller.footerHint ? (
                        <View style={styles.footerHint}>
                            {controller.footerHint}
                        </View>
                    ) : null}
                    {controller.onPrimary ? (
                        <View style={styles.primaryButton}>
                            <RoundButton
                                testID={`${props.testID}-primary`}
                                size="large"
                                title={controller.primaryLabel}
                                disabled={controller.primaryDisabled}
                                onPress={() => {
                                    void controller.onPrimary?.();
                                }}
                            />
                        </View>
                    ) : null}
                    {canShowSkip ? (
                        <View style={styles.skipButton}>
                            <RoundButton
                                testID={`${props.testID}-skip`}
                                size="normal"
                                display="inverted"
                                title={controller.skipLabel ?? undefined}
                                disabled={controller.skipDisabled}
                                onPress={() => {
                                    void controller.onSkip?.();
                                }}
                            />
                        </View>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}
