import { describe, expect, it } from 'vitest';

import { resolveNewSessionCreateAdmission } from './newSessionCreateAdmission';

describe('resolveNewSessionCreateAdmission', () => {
    it('explains the first blocking requirement and advances the reason as it becomes ready', () => {
        const requirements = [
            { ready: false, reason: 'Select a machine' },
            { ready: false, reason: 'Sign in to the selected Agent' },
        ];
        expect(resolveNewSessionCreateAdmission(requirements)).toEqual({
            canCreate: false, disabledReason: 'Select a machine',
        });
        expect(resolveNewSessionCreateAdmission([
            { ...requirements[0], ready: true }, requirements[1],
        ])).toEqual({ canCreate: false, disabledReason: 'Sign in to the selected Agent' });
        expect(resolveNewSessionCreateAdmission(requirements.map(requirement => ({ ...requirement, ready: true })))).toEqual({
            canCreate: true, disabledReason: null,
        });
    });
});
