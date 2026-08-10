import { describe, expect, it } from 'vitest';
import { applySuggestion } from './applySuggestion';
import type { ComposerSuggestionKindId } from './composerSuggestionKinds';

const ALL_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'skill', 'slashCommand'];

type Selection = Parameters<typeof applySuggestion>[1];

type ApplySuggestionCase = {
    name: string;
    content: string;
    selection: Selection;
    suggestion: string;
    expected: { text: string; cursorPosition: number };
    kinds?: readonly ComposerSuggestionKindId[];
    addSpace?: boolean;
};

function assertApplySuggestionCase(testCase: ApplySuggestionCase) {
    const result = applySuggestion(
        testCase.content,
        testCase.selection,
        testCase.suggestion,
        testCase.kinds ?? ALL_KINDS,
        testCase.addSpace,
    );
    expect(result).toEqual(testCase.expected);
}

describe('applySuggestion', () => {
    it.each<ApplySuggestionCase>([
        {
            name: 'replaces mention at end',
            content: 'Hello @joh',
            selection: { start: 10, end: 10 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith ', cursorPosition: 18 },
        },
        {
            name: 'replaces skill at end',
            content: 'I feel $hap',
            selection: { start: 11, end: 11 },
            suggestion: '$happy',
            expected: { text: 'I feel $happy ', cursorPosition: 14 },
        },
        {
            name: 'replaces command at end',
            content: 'Type /hel',
            selection: { start: 9, end: 9 },
            suggestion: '/help',
            expected: { text: 'Type /help ', cursorPosition: 11 },
        },
        {
            name: 'replaces full active word when cursor is in middle',
            content: 'Hello @username here',
            selection: { start: 10, end: 10 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith here', cursorPosition: 17 },
        },
        {
            name: 'replaces when cursor is immediately after prefix',
            content: 'Hello @username',
            selection: { start: 7, end: 7 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith ', cursorPosition: 18 },
        },
    ])('$name', assertApplySuggestionCase);

    it.each<ApplySuggestionCase>([
        {
            name: 'adds separator space before punctuation after active word',
            content: 'Hello @user,welcome',
            selection: { start: 11, end: 11 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith ,welcome', cursorPosition: 18 },
        },
        {
            name: 'does not create duplicate space when one already exists',
            content: 'Hello @user welcome',
            selection: { start: 11, end: 11 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith welcome', cursorPosition: 17 },
        },
        {
            name: 'respects addSpace=false',
            content: 'Hello @user',
            selection: { start: 11, end: 11 },
            suggestion: '@john_smith',
            addSpace: false,
            expected: { text: 'Hello @john_smith', cursorPosition: 17 },
        },
    ])('$name', assertApplySuggestionCase);

    it.each<ApplySuggestionCase>([
        {
            name: 'inserts at cursor when there is no active word',
            content: 'Hello world',
            selection: { start: 6, end: 6 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith world', cursorPosition: 18 },
        },
        {
            name: 'replaces selected text when there is no active word',
            content: 'Hello world',
            selection: { start: 6, end: 11 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith ', cursorPosition: 18 },
        },
        {
            name: 'supports empty input',
            content: '',
            selection: { start: 0, end: 0 },
            suggestion: '@john_smith',
            expected: { text: '@john_smith ', cursorPosition: 12 },
        },
        {
            name: 'supports replacement at start of text',
            content: '@use',
            selection: { start: 4, end: 4 },
            suggestion: '@john_smith',
            expected: { text: '@john_smith ', cursorPosition: 12 },
        },
        {
            name: 'replaces only active prefixed word when several exist',
            content: 'Hi @user1, meet @user2',
            selection: { start: 9, end: 9 },
            suggestion: '@alice',
            expected: { text: 'Hi @alice , meet @user2', cursorPosition: 10 },
        },
        {
            name: 'honours the host eligible-kind subset',
            content: 'Use $var',
            selection: { start: 8, end: 8 },
            suggestion: '$variable',
            kinds: ['skill'],
            expected: { text: 'Use $variable ', cursorPosition: 14 },
        },
        {
            name: 'replaces a dotted path token whole',
            content: 'open @src/fo',
            selection: { start: 12, end: 12 },
            suggestion: '@src/foo.ts',
            expected: { text: 'open @src/foo.ts ', cursorPosition: 17 },
        },
        {
            name: 'replaces the whole token when the cursor sits after a dot',
            content: 'open @src/foo.t here',
            selection: { start: 15, end: 15 },
            suggestion: '@src/foo.ts',
            expected: { text: 'open @src/foo.ts here', cursorPosition: 16 },
        },
        {
            name: 'inserts a quoted token for a path containing a space',
            content: 'open @my',
            selection: { start: 8, end: 8 },
            suggestion: '@"my file.ts"',
            expected: { text: 'open @"my file.ts" ', cursorPosition: 19 },
        },
        {
            name: 'replaces an existing quoted token whole',
            content: 'open @"my fi" here',
            selection: { start: 12, end: 12 },
            suggestion: '@"my file.ts"',
            expected: { text: 'open @"my file.ts" here', cursorPosition: 18 },
        },
        {
            name: 'stops replacement before punctuation characters',
            content: 'Hello @user!',
            selection: { start: 11, end: 11 },
            suggestion: '@john_smith',
            expected: { text: 'Hello @john_smith !', cursorPosition: 18 },
        },
        {
            name: 'stops replacement before parentheses',
            content: '(@user)',
            selection: { start: 6, end: 6 },
            suggestion: '@john_smith',
            expected: { text: '(@john_smith )', cursorPosition: 13 },
        },
    ])('$name', assertApplySuggestionCase);
});
