import { describe, expect, it } from 'vitest';

import { deriveConnectedServiceAuthGroupIdFromName } from './deriveConnectedServiceAuthGroupIdFromName';

describe('deriveConnectedServiceAuthGroupIdFromName', () => {
    it('derives a stable connected-service group id from a user-facing name', () => {
        expect(deriveConnectedServiceAuthGroupIdFromName({ name: 'Fallback Team!' })).toBe('fallback-team');
    });

    it('deduplicates derived group ids without exceeding the protocol limit', () => {
        const name = 'A very long team pool name with enough words to exceed the connected service group id limit';

        expect(deriveConnectedServiceAuthGroupIdFromName({
            name,
            existingGroupIds: [
                'a-very-long-team-pool-name-with-enough-words-to-exceed-the-conne',
            ],
        })).toBe('a-very-long-team-pool-name-with-enough-words-to-exceed-the-con-2');
    });

    it('rejects names that cannot produce a protocol-valid group id', () => {
        expect(deriveConnectedServiceAuthGroupIdFromName({ name: '!!!' })).toBeNull();
    });
});
