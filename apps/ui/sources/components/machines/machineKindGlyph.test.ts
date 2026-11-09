import { describe, expect, it } from 'vitest';

import { resolveMachineKindGlyph } from './machineKindGlyph';

describe('resolveMachineKindGlyph', () => {
    it('tells this computer, a Linux box and every other machine apart', () => {
        expect(resolveMachineKindGlyph({ isThisComputer: true, platform: 'linux' })).toBe('laptop');
        expect(resolveMachineKindGlyph({ isThisComputer: false, platform: 'linux' })).toBe('hard-drives');
        expect(resolveMachineKindGlyph({ isThisComputer: false, platform: 'darwin' })).toBe('desktop');
        // A machine that has not published its platform keeps the neutral glyph rather than a guess.
        expect(resolveMachineKindGlyph({ isThisComputer: false, platform: null })).toBe('desktop');
    });
});
