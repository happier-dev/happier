import { describe, expect, it } from 'vitest';
import {
    formatOptionsXml,
    formatTextWithOptionsForTerminal,
    segmentTrailingOptions,
} from './optionsParser';

describe('segmentTrailingOptions', () => {
    it('splits a trailing options block from the preceding prose', () => {
        const input = 'Which approach do you prefer?\n\n<options>\n    <option>Option A</option>\n    <option>Option B</option>\n</options>';
        const result = segmentTrailingOptions(input);
        expect(result.before).toBe('Which approach do you prefer?\n\n');
        expect(result.options).toEqual(['Option A', 'Option B']);
        expect(result.hasIncompleteTrailingOptions).toBe(false);
    });

    it('preserves surrounding whitespace in before exactly (no trim)', () => {
        const input = '  Leading and trailing spaces.  \n<options>\n<option>Yes</option>\n</options>';
        const result = segmentTrailingOptions(input);
        expect(result.before).toBe('  Leading and trailing spaces.  \n');
    });

    it('returns the full text as before when there is no options block', () => {
        const input = '  Just a plain answer.  ';
        const result = segmentTrailingOptions(input);
        expect(result.before).toBe(input);
        expect(result.options).toEqual([]);
        expect(result.hasIncompleteTrailingOptions).toBe(false);
    });

    it('matches tags case-insensitively', () => {
        const input = 'Pick one:\n<OPTIONS>\n<OPTION>Yes</OPTION>\n<OPTION>No</OPTION>\n</OPTIONS>';
        const result = segmentTrailingOptions(input);
        expect(result.before).toBe('Pick one:\n');
        expect(result.options).toEqual(['Yes', 'No']);
    });

    it('ignores empty option tags', () => {
        const input = '<options><option></option><option>Keep me</option></options>';
        const result = segmentTrailingOptions(input);
        expect(result.options).toEqual(['Keep me']);
    });

    it('does NOT match an <options> block that is not at the end of the text', () => {
        const input = 'See <options><option>A</option></options> then more prose follows.';
        const result = segmentTrailingOptions(input);
        expect(result.before).toBe(input);
        expect(result.options).toEqual([]);
        expect(result.hasIncompleteTrailingOptions).toBe(false);
    });

    it('flags an unclosed trailing options block as incomplete', () => {
        const result = segmentTrailingOptions('Question?\n<options>\n<option>Yes</option>');
        expect(result.hasIncompleteTrailingOptions).toBe(true);
        expect(result.options).toEqual([]);
        expect(result.before).toBe('Question?\n<options>\n<option>Yes</option>');
    });

    it('only segments the LAST/trailing block when several appear', () => {
        const input = 'Literal <options><option>X</option></options> in prose.\n<options>\n<option>Real</option>\n</options>';
        const result = segmentTrailingOptions(input);
        expect(result.before).toBe('Literal <options><option>X</option></options> in prose.\n');
        expect(result.options).toEqual(['Real']);
    });
});

describe('formatOptionsXml', () => {
    it('round-trips options through XML', () => {
        const xml = formatOptionsXml(['One', 'Two']);
        expect(segmentTrailingOptions(xml).options).toEqual(['One', 'Two']);
    });

    it('returns an empty string for no options', () => {
        expect(formatOptionsXml([])).toBe('');
    });
});

describe('formatTextWithOptionsForTerminal', () => {
    it('replaces a trailing options block with a numbered list', () => {
        const input = 'Which approach do you prefer?\n\n<options>\n    <option>Option A</option>\n    <option>Option B</option>\n</options>';
        const result = formatTextWithOptionsForTerminal(input);
        expect(result).toBe('Which approach do you prefer?\n\nOptions:\n  1. Option A\n  2. Option B');
        expect(result).not.toContain('<options>');
    });

    it('renders a numbered list when the message is options-only', () => {
        const input = '<options>\n<option>Yes</option>\n<option>No</option>\n</options>';
        expect(formatTextWithOptionsForTerminal(input)).toBe('Options:\n  1. Yes\n  2. No');
    });

    it('returns text unchanged when there is no options block (exact equality)', () => {
        const input = 'Plain answer with  spacing\npreserved.';
        expect(formatTextWithOptionsForTerminal(input)).toBe(input);
    });

    it('preserves leading and trailing whitespace of the prose exactly', () => {
        const input = '\n\n  Choose:  \n<options>\n<option>A</option>\n<option>B</option>\n</options>';
        expect(formatTextWithOptionsForTerminal(input)).toBe('\n\n  Choose:  \nOptions:\n  1. A\n  2. B');
    });

    it('leaves a fenced/literal <options> block in the MIDDLE of text untouched', () => {
        const input = 'Here is how the markup looks:\n```xml\n<options>\n<option>A</option>\n<option>B</option>\n</options>\n```\nThat is the format.';
        expect(formatTextWithOptionsForTerminal(input)).toBe(input);
    });

    it('leaves a literal <options> block untouched when prose follows it', () => {
        const input = 'The tag <options><option>A</option></options> is used for menus, note the syntax.';
        expect(formatTextWithOptionsForTerminal(input)).toBe(input);
    });

    it('renders only the LAST block, leaving earlier literal ones raw', () => {
        const input = 'Example markup: <options><option>X</option></options>\nNow pick one:\n<options>\n<option>Real A</option>\n<option>Real B</option>\n</options>';
        const result = formatTextWithOptionsForTerminal(input);
        expect(result).toBe('Example markup: <options><option>X</option></options>\nNow pick one:\nOptions:\n  1. Real A\n  2. Real B');
        // The earlier literal block is preserved verbatim.
        expect(result).toContain('<options><option>X</option></options>');
        // Only one block was rendered as a list.
        expect(result.match(/Options:/g)?.length).toBe(1);
    });

    it('drops an empty trailing options block, preserving before exactly', () => {
        const input = 'Before the empty block\n<options>\n</options>';
        expect(formatTextWithOptionsForTerminal(input)).toBe('Before the empty block\n');
    });

    it('returns text unchanged for an incomplete (unclosed) trailing block', () => {
        const input = 'Question?\n<options>\n<option>Yes</option>';
        expect(formatTextWithOptionsForTerminal(input)).toBe(input);
    });
});
