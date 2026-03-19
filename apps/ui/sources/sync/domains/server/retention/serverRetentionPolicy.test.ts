import { describe, expect, it } from 'vitest';

import { hasFiniteRetentionPolicy } from './serverRetentionPolicy';

describe('hasFiniteRetentionPolicy', () => {
    it('treats missing domain entries as non-finite instead of throwing', () => {
        expect(() => hasFiniteRetentionPolicy({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as any)).not.toThrow();
        expect(hasFiniteRetentionPolicy({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as any)).toBe(false);
    });
});
