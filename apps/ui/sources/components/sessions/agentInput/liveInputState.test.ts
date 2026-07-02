import { describe, expect, it } from 'vitest';

import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import {
    areActiveWordsEqual,
    resolveLiveInputTextStatus,
} from './liveInputState';

function largeText(): string {
    return 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
}

describe('liveInputState', () => {
    it('tracks large text status without requiring platform-specific projection', () => {
        const text = `${largeText()} /run`;

        expect(resolveLiveInputTextStatus(text)).toEqual({ length: text.length, hasText: true });
        expect(resolveLiveInputTextStatus(' '.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1))).toEqual({
            length: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
            hasText: false,
        });
    });

    it('tracks length and non-whitespace text without keeping a rendered text copy', () => {
        expect(resolveLiveInputTextStatus('  \n\t')).toEqual({ length: 4, hasText: false });
        expect(resolveLiveInputTextStatus('  /run')).toEqual({ length: 6, hasText: true });
    });

    it('compares active-word snapshots by value', () => {
        const activeWord = {
            word: '/run',
            activeWord: '/r',
            offset: 20,
            length: 4,
            activeLength: 2,
            endOffset: 24,
        };

        expect(areActiveWordsEqual(activeWord, { ...activeWord })).toBe(true);
        expect(areActiveWordsEqual(activeWord, { ...activeWord, activeWord: '/ru' })).toBe(false);
        expect(areActiveWordsEqual(activeWord, undefined)).toBe(false);
    });
});
