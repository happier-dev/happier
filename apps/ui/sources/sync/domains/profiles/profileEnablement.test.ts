import { describe, expect, it } from 'vitest';

import {
    isProfileEnabled,
    readProfileEnabledById,
    setProfileEnabledOverride,
} from './profileEnablement';

describe('profile enablement', () => {
    it('uses entity enablement before a retained preference override', () => {
        const profile = { id: 'custom', enabled: false, defaultEnabled: true };
        expect(isProfileEnabled(profile, { custom: true })).toBe(false);
        expect(isProfileEnabled({ ...profile, enabled: true }, { custom: false })).toBe(true);
        expect(isProfileEnabled({ id: 'anthropic', isBuiltIn: true, defaultEnabled: true }, { anthropic: false })).toBe(false);
    });
    it('projects only boolean overrides while retaining opaque entries when a known override changes', () => {
        const raw = {
            disabled: false,
            future: { retained: true },
            malformed: 'not-an-override',
        };

        expect(readProfileEnabledById(raw)).toEqual({ disabled: false });
        expect(setProfileEnabledOverride(raw, { id: 'disabled' }, true)).toEqual({
            future: { retained: true },
            malformed: 'not-an-override',
        });
    });
});
