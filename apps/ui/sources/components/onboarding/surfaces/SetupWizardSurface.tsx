import * as React from 'react';

import { WizardModalShell } from '../ui/WizardModalShell';
import { useSetupWizardController, type SetupWizardSurfaceProps } from './useSetupWizardController';

export type {
    RemoteRelayRuntimeCompletion,
    RemoteSetupIntent,
    SetupWizardController,
    SetupWizardSurfaceProps,
    SetupWizardSurfaceStyles,
} from './useSetupWizardController';

export function SetupWizardSurface(props: SetupWizardSurfaceProps) {
    const controller = useSetupWizardController(props);

    return (
        <WizardModalShell
            testID={props.testID ?? 'setupWizard.surface'}
            stepIndex={controller.currentStepIndex}
            stepCount={controller.stepCount}
            contentTransitionKey={controller.contentTransitionKey}
            contentTransitionDirection={controller.contentTransitionDirection}
            title={controller.title}
            subtitle={controller.subtitle ?? undefined}
            scrollable={controller.scrollable}
            onSkip={controller.onSkip}
            skipLabel={controller.skipLabel}
            skipDisabled={controller.skipDisabled}
            showSkip={controller.showSkip}
            onBack={controller.onBack}
            backLabel={controller.backLabel}
            showBack={controller.showBack}
            onPrimary={controller.onPrimary}
            primaryLabel={controller.primaryLabel}
            primaryDisabled={controller.primaryDisabled}
            footerHint={controller.footerHint}
        >
            {controller.body}
        </WizardModalShell>
    );
}
