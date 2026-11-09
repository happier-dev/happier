import * as React from 'react';

import { SetupStepProgress } from '@/components/ui/setupBlocks/SetupStepProgress';
import { t } from '@/text';

export type EmailPasswordSetupStep = 'email' | 'confirm' | 'password';
const EMAIL_PASSWORD_SETUP_STEPS: readonly EmailPasswordSetupStep[] = ['email', 'confirm', 'password'];

function setupStepLabel(step: EmailPasswordSetupStep): string {
    if (step === 'email') return t('settingsAccount.nativePassword.email');
    if (step === 'confirm') return t('settingsAccount.nativePassword.setupStepConfirm');
    return t('settingsAccount.nativePassword.password');
}

function setupStepHint(step: EmailPasswordSetupStep): string {
    if (step === 'email') return t('settingsAccount.nativePassword.setupEmailHint');
    if (step === 'confirm') return t('settingsAccount.nativePassword.setupConfirmHint');
    return t('settingsAccount.nativePassword.setupPasswordHint');
}

/**
 * The mailbox-first path to an email and password: add the email, confirm it from the inbox, then
 * choose the password. The current step leads; finished steps are ticked. Shared by every surface
 * that walks this path (Account Security, the account-service section), so the path reads the same.
 */
export function EmailPasswordSetupSteps(props: Readonly<{
    step: EmailPasswordSetupStep;
    /** Replaces the default hint for the current step when the surface can say more. */
    hint?: string;
    testID?: string;
    /** Surfaces that already inset their body drop the step block's own inset. */
    inset?: boolean;
}>) {
    const current = EMAIL_PASSWORD_SETUP_STEPS.indexOf(props.step);
    return (
        <SetupStepProgress
            testID={props.testID ?? 'settings-account-email-password-steps'}
            steps={EMAIL_PASSWORD_SETUP_STEPS.map((step) => ({ key: step, label: setupStepLabel(step) }))}
            current={current}
            accessibilityLabel={t('settingsAccount.nativePassword.setupProgress', {
                step: current + 1,
                total: EMAIL_PASSWORD_SETUP_STEPS.length,
                label: setupStepLabel(props.step),
            })}
            hint={props.hint ?? setupStepHint(props.step)}
            inset={props.inset}
        />
    );
}
