import { describe, expect, it, vi } from 'vitest';

import { getExistingSessionAutomationUnavailableReason } from './existingSessionAutomationAvailabilityUi';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('getExistingSessionAutomationUnavailableReason', () => {
    it('maps blocked session states to user-facing reasons', () => {
        expect(getExistingSessionAutomationUnavailableReason({
            kind: 'blocked',
            reason: 'resume_key_missing',
        })).toBe('automations.create.missingResumeKey');
    });
});
