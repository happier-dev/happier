import { describe, expect, it, vi } from 'vitest';

import { applyDictationToComposer } from './applyDictationToComposer';

describe('applyDictationToComposer', () => {
    it('replaces only the live selection, collapses the cursor after dictation, and restores focus', () => {
        const input = {
            focus: vi.fn(),
            setTextAndSelection: vi.fn(),
        };

        const result = applyDictationToComposer({
            input,
            state: {
                text: 'before selected after',
                selection: { start: 7, end: 15 },
            },
            text: 'dictated',
        });

        expect(result).toEqual({
            text: 'before dictated after',
            selection: { start: 15, end: 15 },
        });
        expect(input.setTextAndSelection).toHaveBeenCalledWith(
            result.text,
            result.selection,
        );
        expect(input.focus).toHaveBeenCalledTimes(1);
    });
});
