import { describe, expect, it } from 'vitest';
import { shouldAutoPromptSecretRequirement } from './secretRequirementPromptEligibility';

describe('shouldAutoPromptSecretRequirement', () => {
    it('does not require a selected machine (still enforces saved/once secrets)', () => {
        const decision = shouldAutoPromptSecretRequirement({
            useProfiles: true,
            selectedProfileId: 'p1',
            shouldShowSecretSection: true,
            isModalOpen: false,
            machineEnvPresenceIsLoading: false,
            selectedMachineId: null,
        });

        expect(decision).toBe(true);
    });

    it('returns false when profiles are disabled or no profile is selected', () => {
        expect(
            shouldAutoPromptSecretRequirement({
                useProfiles: false,
                selectedProfileId: 'p1',
                shouldShowSecretSection: true,
                isModalOpen: false,
                machineEnvPresenceIsLoading: false,
                selectedMachineId: 'm1',
            }),
        ).toBe(false);

        expect(
            shouldAutoPromptSecretRequirement({
                useProfiles: true,
                selectedProfileId: null,
                shouldShowSecretSection: true,
                isModalOpen: false,
                machineEnvPresenceIsLoading: false,
                selectedMachineId: 'm1',
            }),
        ).toBe(false);
    });

    it('returns false when section hidden, modal open, or machine env still loading', () => {
        expect(
            shouldAutoPromptSecretRequirement({
                useProfiles: true,
                selectedProfileId: 'p1',
                shouldShowSecretSection: false,
                isModalOpen: false,
                machineEnvPresenceIsLoading: false,
                selectedMachineId: 'm1',
            }),
        ).toBe(false);

        expect(
            shouldAutoPromptSecretRequirement({
                useProfiles: true,
                selectedProfileId: 'p1',
                shouldShowSecretSection: true,
                isModalOpen: true,
                machineEnvPresenceIsLoading: false,
                selectedMachineId: 'm1',
            }),
        ).toBe(false);

        expect(
            shouldAutoPromptSecretRequirement({
                useProfiles: true,
                selectedProfileId: 'p1',
                shouldShowSecretSection: true,
                isModalOpen: false,
                machineEnvPresenceIsLoading: true,
                selectedMachineId: 'm1',
            }),
        ).toBe(false);
    });
});
