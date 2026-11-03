import * as React from 'react';
import { OnboardingWizardSurfacePresentation } from '@/components/onboarding/surfaces/OnboardingWizardSurface';
import { useOnboardingWizardController, type OnboardingWizardSurfaceProps } from '@/components/onboarding/surfaces/useOnboardingWizardController';

/** Mount the real controller and presenter without retaining a test-only production entry. */
export function OnboardingWizardSurface(props: OnboardingWizardSurfaceProps) {
    const controller = useOnboardingWizardController(props);
    return <OnboardingWizardSurfacePresentation {...props} controller={controller} />;
}
