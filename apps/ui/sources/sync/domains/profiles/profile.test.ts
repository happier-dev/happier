import { describe, expect, it } from 'vitest';

import { getAvatarUrl, getDisplayName, getLinkedProvider, profileDefaults } from './profile';

describe('profile helpers', () => {
    it('treats missing linkedProviders as an empty list when deriving display details', () => {
        const profile = {
            ...profileDefaults,
            firstName: 'Lee',
            linkedProviders: undefined,
            avatar: null,
        } as any;

        expect(getDisplayName(profile)).toBe('Lee');
        expect(getAvatarUrl(profile)).toBeNull();
        expect(getLinkedProvider(profile, 'anthropic')).toBeNull();
    });
});
