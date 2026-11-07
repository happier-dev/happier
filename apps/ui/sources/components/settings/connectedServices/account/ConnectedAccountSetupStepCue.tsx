import * as React from 'react';

import { SetupStepProgress } from '@/components/ui/setupBlocks/SetupStepProgress';
import { t } from '@/text';

export type ConnectedAccountSetupStep = 'settings' | 'signIn';
const STEPS: readonly ConnectedAccountSetupStep[] = ['settings', 'signIn'];

/**
 * The step cue of an add or reconnect flow whose service declares settings to fill in before signing
 * in: "1 Account settings - 2 <the way to sign in>" (the mode's own title: "Access token", "App
 * password"). The controller shows it only on such a flow, so a one-step sign-in carries no cue. It is
 * the shared multi-step settings cue (`SetupStepProgress`).
 */
export function ConnectedAccountSetupStepCue(props: Readonly<{
    step: ConnectedAccountSetupStep;
    /** What the second step asks for, named as the method's title. */
    signInLabel: string;
}>) {
    const label = (step: ConnectedAccountSetupStep) => step === 'settings' ? t('connectedServices.account.configurationTitle') : props.signInLabel;
    return (
        <SetupStepProgress
            testID="connected-account-setup-steps"
            steps={STEPS.map((step) => ({ key: step, label: label(step) }))}
            current={STEPS.indexOf(props.step)}
            accessibilityLabel={label(props.step)}
            inset={false}
        />
    );
}
