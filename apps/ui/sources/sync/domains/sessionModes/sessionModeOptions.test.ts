import { describe, expect, it } from 'vitest';
import { getSessionModeOptionsForPreflightModeList } from './sessionModeOptions';

describe('advertised session mode options', () => {
    it('offers only the backend modes and preserves a concrete default label when advertised', () => {
        const modes = [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }];
        expect(getSessionModeOptionsForPreflightModeList({ availableModes: modes })).toEqual(modes);
        const nativeDefault = { id: 'default', name: 'Manual', description: 'Native default policy' };
        expect(getSessionModeOptionsForPreflightModeList({ availableModes: [nativeDefault, ...modes, modes[0]] }))
            .toEqual([nativeDefault, ...modes]);
        expect(getSessionModeOptionsForPreflightModeList({ availableModes: [] })).toEqual([]);
        expect(getSessionModeOptionsForPreflightModeList({ availableModes: modes, unavailable: true })).toEqual([]);
    });
});
