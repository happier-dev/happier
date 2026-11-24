import * as React from 'react';

import type { CertificateAuthenticationFailure } from '@/auth/flows/executeHomeAuthentication';
import { StepActions, StepProblemHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { StepPrimaryButton, useStepBackOverride } from '@/components/onboarding/unauthShell/stepBack';
import { StepForm } from '@/components/onboarding/unauthShell/StepFormParts';
import { t } from '@/text';

export function CertificateAuthenticationProblem(props: Readonly<{
    outcome: CertificateAuthenticationFailure;
    onRetry: () => void;
    retryDisabled?: boolean;
    onBack?: () => void;
}>) {
    const { outcome } = props;
    useStepBackOverride(props.onBack);
    const title = outcome.reason === 'certificate_required' ? t('welcome.certificateRequiredTitle')
        : outcome.reason === 'certificate_rejected' ? t('welcome.certificateRejectedTitle')
        : t('welcome.signInWithCertificate');
    const subtitle = outcome.reason === 'certificate_required' ? t('welcome.certificateRequiredBody')
        : outcome.reason === 'certificate_rejected' ? t('welcome.certificateRejectedBody')
        : 'message' in outcome && outcome.message ? outcome.message : t('errors.operationFailed');
    return <StepForm>
        <StepProblemHeading iconName="shield-check" title={title} subtitle={subtitle} testID="home-auth-certificate-outcome" />
        <StepActions onBack={props.onBack}>
            <StepPrimaryButton testID="home-auth-certificate-retry" title={t('common.retry')} onPress={props.onRetry} disabled={props.retryDisabled} />
        </StepActions>
    </StepForm>;
}
