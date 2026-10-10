import { describe, expect, it } from 'vitest';
import { promptStackBudgetChoices } from './promptStackBudgetChoices';

describe('Context budget choices', () => {
    it('preserves an exact externally-set budget beside the established word options', () => {
        const choices = promptStackBudgetChoices(3001, { everything: 'Everything', words: count => `${count} words` });
        expect(choices.map(choice => choice.maxChars)).toEqual([null, 3000, 3001, 9000, 24000]);
        expect(new Set(choices.map(choice => choice.id)).size).toBe(choices.length);
        expect(promptStackBudgetChoices(undefined, { everything: 'Everything', words: String }).map(choice => choice.maxChars))
            .toEqual([null, 3000, 9000, 24000]);
    });
});
