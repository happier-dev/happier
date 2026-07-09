import { describe, expect, it } from 'vitest';

import { unsupportedAccountUsage } from './accountUsage.js';

describe('unsupportedAccountUsage', () => {
    it('builds the canonical provider account-usage unsupported result', () => {
        expect(unsupportedAccountUsage('no_verified_usage_source')).toEqual({
            status: 'unsupported',
            reason: 'no_verified_usage_source',
            displayGauge: false,
            canonicalRecord: null,
        });
    });
});
