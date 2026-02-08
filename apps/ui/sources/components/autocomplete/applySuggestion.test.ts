import { describe, expect, it } from 'vitest';
import { applySuggestion } from './applySuggestion';

type Selection = Parameters<typeof applySuggestion>[1];

type ApplySuggestionCase = {
    name: string;
    content: string;
    selection: Selection;
    suggestion: string;
    expected: { text: string; cursorPosition: number };
    prefixes?: string[];
    addSpace?: boolean;
};

function assertApplySuggestionCase(testCase: ApplySuggestionCase) {
    const result = applySuggestion(
        testCase.content,
        testCase.selection,
        testCase.suggestion,
        testCase.prefixes,
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
            name: 'replaces emoji at end',
            content: 'I feel :hap',
            selection: { start: 11, end: 11 },
            suggestion: ':happy:',
            expected: { text: 'I feel :happy: ', cursorPosition: 15 },
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
            prefixes: ['@', ':', '/'],
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
            name: 'supports custom prefix list',
            content: 'Use $var',
            selection: { start: 8, end: 8 },
            suggestion: '$variable',
            prefixes: ['$'],
            expected: { text: 'Use $variable ', cursorPosition: 14 },
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
