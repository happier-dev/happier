import { describe, expect, it } from 'vitest';
import { findActiveWord, findActiveWordString, getActiveWordQuery } from './findActiveWord';

type Selection = Parameters<typeof findActiveWord>[1];

type ActiveWordCase = {
    name: string;
    content: string;
    selection: Selection;
    expected: ReturnType<typeof findActiveWord>;
    prefixes?: string[];
};

function expectedActiveWord(params: {
    word: string;
    offset: number;
    endOffset: number;
    activeWord?: string;
}): NonNullable<ReturnType<typeof findActiveWord>> {
    const activeWord = params.activeWord ?? params.word;
    return {
        word: params.word,
        activeWord,
        offset: params.offset,
        length: params.word.length,
        activeLength: activeWord.length,
        endOffset: params.endOffset,
    };
}

function assertFindCase(testCase: ActiveWordCase) {
    const result = findActiveWord(testCase.content, testCase.selection, testCase.prefixes);
    expect(result).toEqual(testCase.expected);
}

describe('findActiveWord', () => {
    it.each<ActiveWordCase>([
        {
            name: 'detects mention at cursor',
            content: 'Hello @john',
            selection: { start: 11, end: 11 },
            expected: expectedActiveWord({ word: '@john', offset: 6, endOffset: 11 }),
        },
        {
            name: 'detects emoji at cursor',
            content: 'I feel :happy',
            selection: { start: 13, end: 13 },
            expected: expectedActiveWord({ word: ':happy', offset: 7, endOffset: 13 }),
        },
        {
            name: 'detects command at cursor',
            content: 'Type /help for info',
            selection: { start: 10, end: 10 },
            expected: expectedActiveWord({ word: '/help', offset: 5, endOffset: 10 }),
        },
        {
            name: 'supports custom prefix list',
            content: 'This is #important',
            selection: { start: 18, end: 18 },
            prefixes: ['@', ':', '/', '#'],
            expected: expectedActiveWord({ word: '#important', offset: 8, endOffset: 18 }),
        },
        {
            name: 'returns single prefix for immediate suggestions',
            content: 'Hello @',
            selection: { start: 7, end: 7 },
            expected: expectedActiveWord({ word: '@', offset: 6, endOffset: 7 }),
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'does not detect prefix inside email-like token',
            content: 'email@domain.com',
            selection: { start: 16, end: 16 },
            expected: undefined,
        },
        {
            name: 'detects prefix after a space',
            content: 'Hello @user',
            selection: { start: 11, end: 11 },
            expected: expectedActiveWord({ word: '@user', offset: 6, endOffset: 11 }),
        },
        {
            name: 'detects prefix at start of line',
            content: '@user hello',
            selection: { start: 5, end: 5 },
            expected: expectedActiveWord({ word: '@user', offset: 0, endOffset: 5 }),
        },
        {
            name: 'detects prefix after newline',
            content: 'Hello\n@user',
            selection: { start: 11, end: 11 },
            expected: expectedActiveWord({ word: '@user', offset: 6, endOffset: 11 }),
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'stops at comma',
            content: 'Hi, @user',
            selection: { start: 9, end: 9 },
            expected: expectedActiveWord({ word: '@user', offset: 4, endOffset: 9 }),
        },
        {
            name: 'stops at parentheses',
            content: '(@user)',
            selection: { start: 6, end: 6 },
            expected: expectedActiveWord({ word: '@user', offset: 1, endOffset: 6 }),
        },
        {
            name: 'stops at brackets',
            content: '[@user]',
            selection: { start: 6, end: 6 },
            expected: expectedActiveWord({ word: '@user', offset: 1, endOffset: 6 }),
        },
        {
            name: 'stops at braces',
            content: '{@user}',
            selection: { start: 6, end: 6 },
            expected: expectedActiveWord({ word: '@user', offset: 1, endOffset: 6 }),
        },
        {
            name: 'stops at angle brackets',
            content: '<@user>',
            selection: { start: 6, end: 6 },
            expected: expectedActiveWord({ word: '@user', offset: 1, endOffset: 6 }),
        },
        {
            name: 'stops at semicolon',
            content: 'text;@user',
            selection: { start: 10, end: 10 },
            expected: expectedActiveWord({ word: '@user', offset: 5, endOffset: 10 }),
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'returns undefined when cursor is at beginning',
            content: '@user',
            selection: { start: 0, end: 0 },
            expected: undefined,
        },
        {
            name: 'returns undefined for non-collapsed selection',
            content: 'Hello @user',
            selection: { start: 6, end: 11 },
            expected: undefined,
        },
        {
            name: 'returns undefined for empty content',
            content: '',
            selection: { start: 0, end: 0 },
            expected: undefined,
        },
        {
            name: 'returns undefined for plain words without prefix',
            content: 'Hello world',
            selection: { start: 8, end: 8 },
            expected: undefined,
        },
        {
            name: 'returns undefined for unsupported prefix',
            content: 'Hello $user',
            selection: { start: 11, end: 11 },
            expected: undefined,
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'returns full and active word with cursor in middle',
            content: 'Hello @username!',
            selection: { start: 10, end: 10 },
            expected: expectedActiveWord({
                word: '@username',
                activeWord: '@use',
                offset: 6,
                endOffset: 15,
            }),
        },
        {
            name: 'tracks partial token at first cursor position',
            content: 'Type @mention here',
            selection: { start: 7, end: 7 },
            expected: expectedActiveWord({
                word: '@mention',
                activeWord: '@m',
                offset: 5,
                endOffset: 13,
            }),
        },
        {
            name: 'tracks partial token at later cursor position',
            content: 'Type @mention here',
            selection: { start: 10, end: 10 },
            expected: expectedActiveWord({
                word: '@mention',
                activeWord: '@ment',
                offset: 5,
                endOffset: 13,
            }),
        },
        {
            name: 'tracks active segment when punctuation exists after cursor',
            content: 'Hello @user, welcome',
            selection: { start: 9, end: 9 },
            expected: expectedActiveWord({
                word: '@user',
                activeWord: '@us',
                offset: 6,
                endOffset: 11,
            }),
        },
        {
            name: 'tracks active segment with trailing space after full token',
            content: 'Use :smile face',
            selection: { start: 8, end: 8 },
            expected: expectedActiveWord({
                word: ':smile',
                activeWord: ':smi',
                offset: 4,
                endOffset: 10,
            }),
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'resolves mention in mixed-prefix line',
            content: 'Hey @john, use :smile: and /help',
            selection: { start: 9, end: 9 },
            expected: expectedActiveWord({ word: '@john', offset: 4, endOffset: 9 }),
        },
        {
            name: 'resolves emoji in mixed-prefix line',
            content: 'Hey @john, use :smile: and /help',
            selection: { start: 22, end: 22 },
            expected: expectedActiveWord({ word: ':smile:', offset: 15, endOffset: 22 }),
        },
        {
            name: 'resolves command in mixed-prefix line',
            content: 'Hey @john, use :smile: and /help',
            selection: { start: 32, end: 32 },
            expected: expectedActiveWord({ word: '/help', offset: 27, endOffset: 32 }),
        },
        {
            name: 'handles long prefixed token',
            content: 'Hello @very_long_username_here',
            selection: { start: 30, end: 30 },
            expected: expectedActiveWord({
                word: '@very_long_username_here',
                offset: 6,
                endOffset: 30,
            }),
        },
    ])('$name', assertFindCase);
});

describe('findActiveWordString', () => {
    it('returns active word string for backward compatibility', () => {
        const content = 'Hello @john';
        const selection = { start: 11, end: 11 };
        expect(findActiveWordString(content, selection)).toBe('@john');
    });

    it('returns undefined when no active word exists', () => {
        const content = 'Hello world';
        const selection = { start: 11, end: 11 };
        expect(findActiveWordString(content, selection)).toBeUndefined();
    });
});

describe('getActiveWordQuery', () => {
    it.each([
        { activeWord: '@user', expected: 'user' },
        { activeWord: ':smile', expected: 'smile' },
        { activeWord: '/help', expected: 'help' },
        { activeWord: '#tag', expected: 'tag' },
        { activeWord: '@', expected: '' },
        { activeWord: ':', expected: '' },
        { activeWord: '/', expected: '' },
        { activeWord: '#', expected: '' },
        { activeWord: '', expected: '' },
        { activeWord: '@very_long_username', expected: 'very_long_username' },
    ])('extracts query from "$activeWord"', ({ activeWord, expected }) => {
        expect(getActiveWordQuery(activeWord)).toBe(expected);
    });
});
