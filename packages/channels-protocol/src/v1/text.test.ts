import { describe, expect, it } from 'vitest';

import { countConversationTextUnits } from './text.js';

describe('Channels V1 outbound text units', () => {
    it('counts the exact provider-declared unit without conflating code points and UTF-16 units', () => {
        const value = 'A😀e\u0301';

        expect(countConversationTextUnits(value, 'utf8Bytes')).toBe(8);
        expect(countConversationTextUnits(value, 'utf16CodeUnits')).toBe(5);
        expect(countConversationTextUnits(value, 'unicodeCodePoints')).toBe(4);
    });
});
