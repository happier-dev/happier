import { describe, expect, it } from 'vitest';

import { getPreferredDirectBrowseProviderId } from './getPreferredDirectBrowseProviderId';

describe('getPreferredDirectBrowseProviderId', () => {
    it('returns the current selection when it is still present', () => {
        expect(getPreferredDirectBrowseProviderId(['codex', 'claude'], 'claude')).toBe('claude');
    });

    it('falls back to the first available provider without hardcoded defaults', () => {
        expect(getPreferredDirectBrowseProviderId(['claude', 'opencode'], 'codex')).toBe('claude');
        expect(getPreferredDirectBrowseProviderId([], 'codex')).toBe(null);
    });
});
