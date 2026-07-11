import { describe, expect, it } from 'vitest';
import {
    formatOptionsXml,
    formatTextWithOptionsForTerminal,
    hasIncompleteOptions,
    parseOptionsFromText,
} from './optionsParser';

describe('parseOptionsFromText', () => {
    it('extracts options and returns text without the options block', () => {
        const input = 'Which approach do you prefer?\n\n<options>\n    <option>Option A</option>\n    <option>Option B</option>\n</options>';
        const result = parseOptionsFromText(input);
        expect(result.text).toBe('Which approach do you prefer?');
        expect(result.options).toEqual(['Option A', 'Option B']);
    });

    it('returns trimmed text and empty options when no options block exists', () => {
        const result = parseOptionsFromText('  Just a plain answer.  ');
        expect(result.text).toBe('Just a plain answer.');
        expect(result.options).toEqual([]);
    });

    it('matches tags case-insensitively', () => {
        const input = 'Pick one:\n<OPTIONS>\n<OPTION>Yes</OPTION>\n<OPTION>No</OPTION>\n</OPTIONS>';
        const result = parseOptionsFromText(input);
        expect(result.text).toBe('Pick one:');
        expect(result.options).toEqual(['Yes', 'No']);
    });

    it('ignores empty option tags', () => {
        const input = '<options><option></option><option>Keep me</option></options>';
        const result = parseOptionsFromText(input);
        expect(result.options).toEqual(['Keep me']);
    });
});

describe('hasIncompleteOptions', () => {
    it('detects an opening tag without a closing tag', () => {
        expect(hasIncompleteOptions('Question?\n<options>\n<option>Yes</option>')).toBe(true);
    });

    it('returns false for complete blocks and plain text', () => {
        expect(hasIncompleteOptions('<options><option>Yes</option></options>')).toBe(false);
        expect(hasIncompleteOptions('No options here')).toBe(false);
    });
});

describe('formatOptionsXml', () => {
    it('round-trips options through XML', () => {
        const xml = formatOptionsXml(['One', 'Two']);
        expect(parseOptionsFromText(xml).options).toEqual(['One', 'Two']);
    });

    it('returns an empty string for no options', () => {
        expect(formatOptionsXml([])).toBe('');
    });
});

describe('formatTextWithOptionsForTerminal', () => {
    it('replaces the options block with a numbered list', () => {
        const input = 'Which approach do you prefer?\n\n<options>\n    <option>Option A</option>\n    <option>Option B</option>\n</options>';
        const result = formatTextWithOptionsForTerminal(input);
        expect(result).toBe('Which approach do you prefer?\n\nOptions:\n  1. Option A\n  2. Option B');
        expect(result).not.toContain('<options>');
    });

    it('renders a numbered list when the message is options-only', () => {
        const input = '<options>\n<option>Yes</option>\n<option>No</option>\n</options>';
        expect(formatTextWithOptionsForTerminal(input)).toBe('Options:\n  1. Yes\n  2. No');
    });

    it('returns text unchanged when there is no options block', () => {
        const input = 'Plain answer with  spacing\npreserved.';
        expect(formatTextWithOptionsForTerminal(input)).toBe(input);
    });

    it('formats every options block when a message contains more than one', () => {
        const text = 'First question:\n<options>\n<option>A</option>\n<option>B</option>\n</options>\nSecond question:\n<options>\n<option>C</option>\n</options>';
        const result = formatTextWithOptionsForTerminal(text);
        expect(result).not.toContain('<options>');
        expect(result).toContain('  1. A');
        expect(result).toContain('  2. B');
        expect(result).toContain('First question:');
        expect(result).toContain('Second question:');
        expect(result.match(/Options:/g)?.length).toBe(2);
        expect(result).toContain('  1. C');
    });

    it('drops empty options blocks entirely', () => {
        const result = formatTextWithOptionsForTerminal('Before\n<options>\n</options>\nAfter');
        expect(result).not.toContain('<options>');
        expect(result).toContain('Before');
        expect(result).toContain('After');
    });

    it('returns text unchanged for an incomplete options block', () => {
        const input = 'Question?\n<options>\n<option>Yes</option>';
        expect(formatTextWithOptionsForTerminal(input)).toBe(input);
    
});
});
