import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { usePreventRemove } from '@react-navigation/native';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';

import { UnauthenticatedStep } from '../unauthShell/UnauthenticatedStep';
import { ActiveRelaySummary } from '../ui/ActiveRelaySummary';
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

const bareStylesheet = StyleSheet.create(() => ({
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
    const hasFooter = Boolean(controller.onPrimary) || canShowSkip;
    // The Home a step acts on is one quiet line above its heading, not a capsule among its actions;
    // while choosing a Home the list itself shows the selection.
    const homeContext = controller.homeContext?.status === 'active' ? controller.homeContext : null;

    return (
        <UnauthenticatedStep
            testID={`${props.testID}-bare`}
            context={homeContext ? (
                <ActiveRelaySummary
                    idPrefix={`${props.testID}-relay-hint`}
                    relayUrl={homeContext.relayUrl}
                    status="active"
                    presentation="line"
                />
            ) : null}
            title={controller.bodyOwnsHeading ? undefined : controller.title}
            subtitle={controller.bodyOwnsHeading ? undefined : controller.subtitle}
            bodyTransitionKey={controller.stepId}
            bodyTransitionDirection={controller.contentTransitionDirection}
            footer={hasFooter ? (
                <>
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
                </>
            ) : null}
        >
            {controller.body}
        </UnauthenticatedStep>
    );
}
