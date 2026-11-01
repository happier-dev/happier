import { describe, expect, it } from 'vitest';

import { buildUniversalSearchSessionTitleKey } from './universalSearchResult';

describe('UniversalSearchController transcript title identity', () => {
    it('keys titles independently by Account, Home and Session', () => {
        const key = buildUniversalSearchSessionTitleKey('account-a', 'home-a', 'session-1');
        expect(buildUniversalSearchSessionTitleKey('account-a', 'home-a', 'session-1')).toBe(key);
        expect(buildUniversalSearchSessionTitleKey('account-b', 'home-a', 'session-1')).not.toBe(key);
        expect(buildUniversalSearchSessionTitleKey('account-a', 'home-b', 'session-1')).not.toBe(key);
        expect(buildUniversalSearchSessionTitleKey('account-a', 'home-a', 'session-2')).not.toBe(key);
    });
});
