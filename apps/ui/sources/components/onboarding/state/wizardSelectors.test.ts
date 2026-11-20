import { describe, expect, it } from 'vitest';

import { canSkipWizardStep, getNextWizardStepId, getPreviousWizardStepId, getVisibleWizardStepIds, getWizardProgress } from './wizardSelectors';

const onboardingContext = {
    mode: 'onboarding' as const,
    platform: 'web' as const,


    canRunSystemTasks: false,
    relaySelection: { choiceId: null, serverUrl: null, locked: false },
    relayAccessProviderId: null,

    relaySwitchConfirmationPending: false,
    authIntent: 'standard' as const,
};


describe('wizardSelectors', () => {
    it('derives onboarding step order with the embedded restore step', () => {
        expect(getVisibleWizardStepIds(onboardingContext)).toEqual([
            'welcome',
            'relay_select',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_service_select',
            'auth_lost_access',
        ]);
    });

    it('shows the relay url step only when a custom relay has not been resolved yet', () => {
        expect(getVisibleWizardStepIds({
            ...onboardingContext,

            relaySelection: { choiceId: 'customUrl' as const, serverUrl: 'https://relay.example.com', locked: false },
        })).toEqual([
            'welcome',
            'relay_select',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_service_select',
            'auth_lost_access',
        ]);

        expect(getVisibleWizardStepIds({
            ...onboardingContext,

            relaySelection: { choiceId: 'customUrl' as const, serverUrl: null, locked: false },
        })).toEqual([
            'welcome',
            'relay_select',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_service_select',
            'auth_lost_access',
        ]);
    });

    it('reports skip and progress metadata', () => {
        expect(canSkipWizardStep(onboardingContext, 'auth')).toBe(false);
        expect(getNextWizardStepId(onboardingContext, 'auth')).toBe('auth_restore');
        expect(getPreviousWizardStepId({
            ...onboardingContext,
            relaySelection: { choiceId: 'customUrl' as const, serverUrl: 'https://relay.example.com', locked: false },
        }, 'auth')).toBe('relay_select');
        expect(getWizardProgress(onboardingContext, 'auth')).toEqual({ current: 3, total: 7 });
    });
});
