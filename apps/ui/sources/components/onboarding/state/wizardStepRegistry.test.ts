import { describe, expect, it } from 'vitest';

import type { WizardContext } from './wizardTypes';
import { getWizardStepDefinition } from './wizardStepRegistry';

describe('wizardStepRegistry', () => {
    it('shows the background service handoff step on native for the local-handoff branch', () => {
        const context: WizardContext = {
            mode: 'onboarding',
            platform: 'native',
            canScanQr: false,
            scanStepEnabled: false,
            canRunSystemTasks: false,
            relaySelection: {
                choiceId: 'thisComputer',
                serverUrl: 'https://relay.local.test',
                relayProfileId: null,
                locked: false,
            },
            relayAccessProviderId: null,
            relayLockConfirmationPending: false,
            relaySwitchConfirmationPending: false,
            authIntent: 'standard',
            setupAction: null,
        };

        const step = getWizardStepDefinition('background_service_handoff');
        expect(step.visibleWhen(context)).toBe(true);
    });

    it('keeps provider setup visible for the local relay hosting setup branch', () => {
        const context: WizardContext = {
            mode: 'setup',
            platform: 'desktop',
            canScanQr: false,
            scanStepEnabled: false,
            canRunSystemTasks: true,
            relaySelection: {
                choiceId: 'customUrl',
                serverUrl: 'https://relay.local.test',
                relayProfileId: 'relay-local',
                locked: true,
            },
            relayAccessProviderId: null,
            relayLockConfirmationPending: false,
            relaySwitchConfirmationPending: false,
            authIntent: 'standard',
            setupAction: 'relayLocal',
        };

        const step = getWizardStepDefinition('providers_optional');
        expect(step.visibleWhen(context)).toBe(true);
    });
});
