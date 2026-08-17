import { describe, expect, it } from 'vitest';

import {
    readProfileEnabledById,
    setProfileEnabledOverride,
} from './profileEnablement';

describe('profile enablement', () => {
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
