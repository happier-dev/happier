import * as React from 'react';

import type { CertificateAuthenticationFailure } from '@/auth/flows/executeHomeAuthentication';
import { StepProblemHeading } from '@/components/onboarding/unauthShell/UnauthenticatedStep';
import { StepPrimaryButton } from '@/components/onboarding/unauthShell/stepBack';
import { StepForm, StepQuietAction } from '@/components/onboarding/unauthShell/StepFormParts';
import { t } from '@/text';

export function CertificateAuthenticationProblem(props: Readonly<{
    outcome: CertificateAuthenticationFailure;
    onRetry: () => void;
    retryDisabled?: boolean;
    onBack?: () => void;
}>) {
    const { outcome } = props;
    const title = outcome.reason === 'certificate_required' ? t('welcome.certificateRequiredTitle')
        : outcome.reason === 'certificate_rejected' ? t('welcome.certificateRejectedTitle')
        : t('welcome.signInWithCertificate');
    const subtitle = outcome.reason === 'certificate_required' ? t('welcome.certificateRequiredBody')
        : outcome.reason === 'certificate_rejected' ? t('welcome.certificateRejectedBody')
        : 'message' in outcome && outcome.message ? outcome.message : t('errors.operationFailed');
    return <StepForm>
        <StepProblemHeading iconName="shield-check" title={title} subtitle={subtitle} testID="home-auth-certificate-outcome" />
        <StepPrimaryButton testID="home-auth-certificate-retry" title={t('common.retry')} onPress={props.onRetry} disabled={props.retryDisabled} />
        {props.onBack ? <StepQuietAction testID="home-auth-certificate-back" label={t('common.back')} onPress={props.onBack} /> : null}
    </StepForm>;
}
