import { describe, expect, it } from 'vitest';

import { wizardReducer, createWizardState } from './wizardReducer';
import type { WizardState } from './wizardTypes';

const onboardingContext = {
    mode: 'onboarding' as const,
    platform: 'web' as const,


    canRunSystemTasks: false,
    relaySelection: { choiceId: null, serverUrl: null, locked: false },
    relayAccessProviderId: null,

    relaySwitchConfirmationPending: false,
    authIntent: 'standard' as const,
};

function makeState(overrides?: Partial<WizardState>): WizardState {
    return createWizardState({
        context: onboardingContext,
        currentStepId: 'welcome',
        history: [],
        resumeState: null,

        ...overrides,
    });
}

describe('wizardReducer', () => {
    it('advances through visible steps', () => {
        const state = wizardReducer(makeState(), { type: 'wizard/advance' });
        expect(state.currentStepId).toBe('relay_select');
        expect(state.history).toEqual(['welcome']);
    });

    it('moves back through visible steps', () => {
        const state = wizardReducer(
            makeState({
                context: {
                    ...onboardingContext,
                    relaySelection: { choiceId: 'customUrl', serverUrl: 'https://relay.example.com', locked: false },
                },
                currentStepId: 'auth',
            }),
            { type: 'wizard/back' },
        );
        expect(state.currentStepId).toBe('relay_select');
    });

    it('uses navigation history for back when available (even if the previous visible step differs)', () => {
        const state = makeState({
            currentStepId: 'auth',
            history: ['welcome', 'relay_select'],
        });

        const withLostAccess = wizardReducer(state, { type: 'wizard/goToStep', stepId: 'auth_lost_access' });
        expect(withLostAccess.history).toEqual(['welcome', 'relay_select', 'auth']);

        const back = wizardReducer(withLostAccess, { type: 'wizard/back' });
        expect(back.currentStepId).toBe('auth');
    });

    it('updates relay selection and auth intent', () => {
        const relaySelection = { choiceId: 'customUrl' as const, serverUrl: 'https://relay.example.com', locked: true };
        const withRelay = wizardReducer(makeState(), { type: 'wizard/setRelaySelection', relaySelection });
        expect(withRelay.context.relaySelection).toEqual(relaySelection);

        const withIntent = wizardReducer(withRelay, { type: 'wizard/setAuthIntent', authIntent: 'lost_access' });
        expect(withIntent.context.authIntent).toBe('lost_access');
    });

});
