import { describe, expect, it } from 'vitest';

import { getPreferredExternalSessionBrowseProviderId } from './getPreferredExternalSessionBrowseProviderId';

describe('getPreferredExternalSessionBrowseProviderId', () => {
    it('returns the current selection when it is still present', () => {
        expect(getPreferredExternalSessionBrowseProviderId(['codex', 'claude'], 'claude')).toBe('claude');
    });

    it('falls back to the first available provider without hardcoded defaults', () => {
        expect(getPreferredExternalSessionBrowseProviderId(['claude', 'opencode'], 'codex')).toBe('claude');
        expect(getPreferredExternalSessionBrowseProviderId([], 'codex')).toBe(null);
    });
});
