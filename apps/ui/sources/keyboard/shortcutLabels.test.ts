import { describe, expect, it } from 'vitest';

import { splitKeybindingLabel } from './shortcutLabels';

describe('splitKeybindingLabel', () => {
    it('splits a written combination into one keycap per key', () => {
        expect(splitKeybindingLabel('Ctrl+Shift+Enter')).toEqual(['Ctrl', 'Shift', 'Enter']);
    });

    it('draws a Mac combination\'s modifiers as their glyphs, as the keyboard prints them', () => {
        expect(splitKeybindingLabel('Cmd+Enter')).toEqual(['⌘', 'Enter']);
        expect(splitKeybindingLabel('Cmd+Shift+Enter')).toEqual(['⇧', '⌘', 'Enter']);
        expect(splitKeybindingLabel('Ctrl+Option+K')).toEqual(['⌃', '⌥', 'K']);
    });

    it('keeps a literal plus key as one keycap', () => {
        expect(splitKeybindingLabel('Ctrl++')).toEqual(['Ctrl', '+']);
    });

    it('splits a Mac glyph combination into one keycap per modifier and key', () => {
        expect(splitKeybindingLabel('⇧⌘2')).toEqual(['⇧', '⌘', '2']);
        expect(splitKeybindingLabel('⌃⌥⇧⌘K')).toEqual(['⌃', '⌥', '⇧', '⌘', 'K']);
    });

    it('keeps a lone modifier glyph as its own keycap', () => {
        expect(splitKeybindingLabel('⌘')).toEqual(['⌘']);
    });
});
