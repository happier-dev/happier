import { describe, expect, it } from 'vitest';
import { parseKeybindingRule } from './keyboardPreferenceMutations';

describe('physical punctuation bindings', () => {
    it('keeps the physical slash identity when Option changes the typed character', () => {
        expect(parseKeybindingRule('Mod+Alt+/')).toMatchObject({ key: '/', code: 'Slash', mod: true, alt: true });
    });
    it('represents a shifted plus without confusing the chord separator with the key', () => {
        expect(parseKeybindingRule('Shift+=')).toMatchObject({ code: 'Equal', shift: true });
        expect(parseKeybindingRule('NumpadAdd')).toMatchObject({ code: 'NumpadAdd' });
    });
});
