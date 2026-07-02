import { describe, expect, it } from 'vitest';

import { resolveSessionListSelectionPointerAction } from './sessionListSelectionPointer';

describe('resolveSessionListSelectionPointerAction', () => {
    it('keeps a plain row press as navigation outside selection mode', () => {
        expect(resolveSessionListSelectionPointerAction({
            isSelectionMode: false,
            platform: 'macos',
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
        })).toBe('open');
    });

    it('toggles rows for platform command-click and adds ranges with shift', () => {
        expect(resolveSessionListSelectionPointerAction({
            isSelectionMode: false,
            platform: 'macos',
            shiftKey: false,
            ctrlKey: false,
            metaKey: true,
        })).toBe('toggle');

        expect(resolveSessionListSelectionPointerAction({
            isSelectionMode: false,
            platform: 'windows',
            shiftKey: true,
            ctrlKey: true,
            metaKey: false,
        })).toBe('addRange');
    });

    it('selects ranges with shift and toggles plain row presses once already in selection mode', () => {
        expect(resolveSessionListSelectionPointerAction({
            isSelectionMode: false,
            platform: 'windows',
            shiftKey: true,
            ctrlKey: false,
            metaKey: false,
        })).toBe('selectRange');

        expect(resolveSessionListSelectionPointerAction({
            isSelectionMode: true,
            platform: 'windows',
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
        })).toBe('toggle');
    });
});
