import { describe, expect, it } from 'vitest';
import {
    formatComposerSuggestionToken,
    isComposerTokenBoundaryChar,
    parseComposerSuggestionQuery,
    parseComposerTokenEnd,
} from './composerSuggestionGrammar';
import { findActiveWord } from './findActiveWord';
import type { ComposerSuggestionKindId } from './composerSuggestionKinds';

const ALL_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'skill', 'slashCommand'];

describe('parseComposerSuggestionQuery', () => {
    it.each([
        { activeWord: '@user', expected: 'user' },
        { activeWord: '$smile', expected: 'smile' },
        { activeWord: '/help', expected: 'help' },
        { activeWord: '@', expected: '' },
        { activeWord: '$', expected: '' },
        { activeWord: '/', expected: '' },
        { activeWord: '@README.md', expected: 'README.md' },
        { activeWord: '@plugin:acme/formatter', expected: 'plugin:acme/formatter' },
    ])('reads "$activeWord" as "$expected"', ({ activeWord, expected }) => {
        expect(parseComposerSuggestionQuery(activeWord)?.query).toBe(expected);
    });

    it('unquotes a quoted span so the search term excludes the quotes', () => {
        expect(parseComposerSuggestionQuery('@"my file.ts"')?.query).toBe('my file.ts');
    });

    it('unquotes a still-open quoted span', () => {
        expect(parseComposerSuggestionQuery('@"my fi')?.query).toBe('my fi');
    });

    it('reads an escaped quote inside a span as a single quote', () => {
        expect(parseComposerSuggestionQuery('@"a""b.ts"')?.query).toBe('a"b.ts');
    });

    it.each(['$', '/'] as const)('unquotes a public reference span for %s', (trigger) => {
        expect(parseComposerSuggestionQuery(`${trigger}"Issue 42"`)?.query).toBe('Issue 42');
    });

    it('returns null when the text does not start with a trigger', () => {
        expect(parseComposerSuggestionQuery('plain')).toBeNull();
        expect(parseComposerSuggestionQuery('')).toBeNull();
    });
});

describe('formatComposerSuggestionToken', () => {
    it.each([
        { value: 'README.md', expected: '@README.md' },
        { value: 'src/foo.ts', expected: '@src/foo.ts' },
        { value: 'C:\\repo\\App.tsx', expected: '@C:\\repo\\App.tsx' },
        { value: 'plugin:acme/formatter', expected: '@plugin:acme/formatter' },
    ])('leaves "$value" unquoted', ({ value, expected }) => {
        expect(formatComposerSuggestionToken('@', value)).toBe(expected);
    });

    it.each([
        { value: 'my file.ts', expected: '@"my file.ts"' },
        { value: 'docs/my notes (draft).md', expected: '@"docs/my notes (draft).md"' },
        { value: 'weird,name.ts', expected: '@"weird,name.ts"' },
        { value: 'a"b.ts', expected: '@"a""b.ts"' },
    ])('quotes "$value"', ({ value, expected }) => {
        expect(formatComposerSuggestionToken('@', value)).toBe(expected);
    });

    it('leaves built-in command and skill names unquoted', () => {
        expect(formatComposerSuggestionToken('/', 'h.review')).toBe('/h.review');
        expect(formatComposerSuggestionToken('$', 'review')).toBe('$review');
    });
});

describe('token round-trip (INV-3)', () => {
    it.each([
        'README.md',
        'src/foo.ts',
        'my file.ts',
        'docs/my notes (draft).md',
        'weird,name.ts',
        'a"b.ts',
        'plugin:acme/formatter',
        'C:\\repo\\App.tsx',
        'notes-🙂.md',
    ])('a formatted token for "%s" re-parses to the same value and span', (value) => {
        const token = formatComposerSuggestionToken('@', value);
        const content = `open ${token} here`;
        const cursor = 5 + token.length;

        const active = findActiveWord(content, { start: cursor, end: cursor }, ALL_KINDS);

        expect(active?.offset).toBe(5);
        expect(active?.endOffset).toBe(5 + token.length);
        expect(active?.word).toBe(token);
        expect(parseComposerSuggestionQuery(active!.word)?.query).toBe(value);
    });

    it.each(['$', '/'] as const)(
        'round-trips a public reference label with spaces for the %s trigger',
        (trigger) => {
            const token = formatComposerSuggestionToken(trigger, 'Issue 42');
            const content = `open ${token} here`;
            const cursor = 5 + token.length;

            const active = findActiveWord(content, { start: cursor, end: cursor }, ALL_KINDS);

            expect(active?.word).toBe(token);
            expect(parseComposerSuggestionQuery(active!.word)?.query).toBe('Issue 42');
        },
    );
});

describe('parseComposerTokenEnd', () => {
    it('never scans past the supplied bound', () => {
        const content = `@${'a'.repeat(100)}`;
        expect(parseComposerTokenEnd(content, 0, 10)).toBe(10);
    });

    it('returns the trigger index + 1 for an immediately delimited token', () => {
        expect(parseComposerTokenEnd('@ rest', 0, 6)).toBe(1);
    });
});

/**
 * A quoted span lets one token hold a name with spaces (`@"my session"`). Its
 * opening quote therefore suspends the whitespace rule that normally ends a
 * token — so an opening quote that is NOT the start of a value turns the rest of
 * the line into one token and holds the picker open across every following word.
 *
 * `"@"` in prose is exactly that shape, and it is the reported defect: quoting
 * the mention character while writing about it opened the picker and kept it
 * open. The span now opens only when a value actually follows the quote.
 */
describe('an opening quote with no value after it', () => {
    it('does not open a span when a space follows the quote', () => {
        expect(parseComposerTokenEnd('@" rest', 0, 7)).toBe(1);
    });

    it('does not open a span when the quote ends the content', () => {
        expect(parseComposerTokenEnd('@"', 0, 2)).toBe(1);
    });

    it('still opens a span for a real quoted value', () => {
        expect(parseComposerTokenEnd('@"my session"', 0, 13)).toBe(13);
    });

    it('leaves a quoted mention character in prose inert', () => {
        const content = '"@" is the mention character';

        expect(findActiveWord(content, { start: 3, end: 3 }, ALL_KINDS)).toBeUndefined();
        expect(findActiveWord(content, { start: content.length, end: content.length }, ALL_KINDS))
            .toBeUndefined();
    });

    it('keeps searching a quoted name across its spaces', () => {
        const content = '@"fix detached dev';
        const active = findActiveWord(content, { start: content.length, end: content.length }, ALL_KINDS);

        expect(active?.word).toBe(content);
        expect(parseComposerSuggestionQuery(active!.word)?.query).toBe('fix detached dev');
    });

    /**
     * The one value shape the grammar cannot express, stated rather than left to
     * be discovered: quoting is what carries a space, so a value that STARTS with
     * one has no representation. No candidate source produces such a value — file
     * paths come from ripgrep, session slugs from `[a-z0-9-]+`, plugin and skill
     * names from their catalogs — and accepting it would reopen the `"@"` defect.
     */
    it('does not round-trip a value beginning with whitespace, by construction', () => {
        const token = formatComposerSuggestionToken('@', ' leading.ts');

        expect(token).toBe('@" leading.ts"');
        expect(parseComposerTokenEnd(token, 0, token.length)).toBe(1);
    });
});

describe('isComposerTokenBoundaryChar', () => {
    it.each([' ', '\t', '\n', '\u00A0', ',', ';', '(', ')', '[', ']', '{', '}', '<', '>', '!', '?', '"', ''])(
        'treats %j as a boundary',
        (char) => {
            expect(isComposerTokenBoundaryChar(char)).toBe(true);
        },
    );

    it.each(['.', '/', '\\', ':', '-', '_', '~', '#', 'a', '0', "'"])('treats %j as part of a token', (char) => {
        expect(isComposerTokenBoundaryChar(char)).toBe(false);
    });
});
