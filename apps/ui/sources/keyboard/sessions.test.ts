import { describe, expect, it } from 'vitest';

import { resolveDefaultSessionMruShortcutAvailability } from './sessions';

describe('session keyboard shortcut availability', () => {
    it('disables the default Ctrl+Tab MRU binding on browser web unless explicitly opted in', () => {
        expect(resolveDefaultSessionMruShortcutAvailability({ platform: 'web', webHost: 'browser', optIn: false })).toBe(false);
        expect(resolveDefaultSessionMruShortcutAvailability({ platform: 'web', webHost: 'desktop', optIn: false })).toBe(true);
        expect(resolveDefaultSessionMruShortcutAvailability({ platform: 'ios', webHost: null, optIn: false })).toBe(true);
        expect(resolveDefaultSessionMruShortcutAvailability({ platform: 'web', webHost: 'browser', optIn: true })).toBe(true);
    });
});
