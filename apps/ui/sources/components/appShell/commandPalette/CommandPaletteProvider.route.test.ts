import { describe, expect, it } from 'vitest';

import { readActiveSessionIdFromRoute } from './CommandPaletteProvider';

describe('Command Palette active Session route', () => {
    it('never treats Expo Router\'s literal [id] file pattern as a Session id', () => {
        expect(readActiveSessionIdFromRoute(['(app)', 'session', '[id]'], undefined)).toBeNull();
        expect(readActiveSessionIdFromRoute(['(app)', 'session', '[id]'], '[id]')).toBeNull();
    });

    it('retains a concrete normalized Session route parameter', () => {
        expect(readActiveSessionIdFromRoute(
            ['(app)', 'session', '[id]'],
            ['  session-42  '],
        )).toBe('session-42');
    });
});
