import { describe, expect, it } from 'vitest';
import type { ComposerSuggestionKindId } from './composerSuggestionKinds';
import { findActiveWord } from './findActiveWord';

type Selection = Parameters<typeof findActiveWord>[1];

/** Session-composer eligibility: every kind, i.e. every trigger. */
const ALL_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'skill', 'slashCommand'];

type ActiveWordCase = {
    name: string;
    content: string;
    selection: Selection;
    expected: ReturnType<typeof findActiveWord>;
    kinds?: readonly ComposerSuggestionKindId[];
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
    const result = findActiveWord(testCase.content, testCase.selection, testCase.kinds ?? ALL_KINDS);
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
            name: 'detects skill at cursor',
            content: 'I feel $happy',
            selection: { start: 13, end: 13 },
            expected: expectedActiveWord({ word: '$happy', offset: 7, endOffset: 13 }),
        },
        {
            name: 'detects command at cursor',
            content: 'Type /help for info',
            selection: { start: 10, end: 10 },
            expected: expectedActiveWord({ word: '/help', offset: 5, endOffset: 10 }),
        },
        {
            name: 'returns single trigger for immediate suggestions',
            content: 'Hello @',
            selection: { start: 7, end: 7 },
            expected: expectedActiveWord({ word: '@', offset: 6, endOffset: 7 }),
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'does not detect trigger inside email-like token',
            content: 'email@domain.com',
            selection: { start: 16, end: 16 },
            expected: undefined,
        },
        {
            name: 'detects trigger after a space',
            content: 'Hello @user',
            selection: { start: 11, end: 11 },
            expected: expectedActiveWord({ word: '@user', offset: 6, endOffset: 11 }),
        },
        {
            name: 'detects trigger at start of line',
            content: '@user hello',
            selection: { start: 5, end: 5 },
            expected: expectedActiveWord({ word: '@user', offset: 0, endOffset: 5 }),
        },
        {
            name: 'detects trigger after newline',
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
            name: 'returns undefined for plain words without a trigger',
            content: 'Hello world',
            selection: { start: 8, end: 8 },
            expected: undefined,
        },
    ])('$name', assertFindCase);

    it('does not scan unbounded minified tokens before the cursor', () => {
        const content = `/${'a'.repeat(20_000)}`;
        const selection = { start: content.length, end: content.length };

        expect(findActiveWord(content, selection, ALL_KINDS)).toBeUndefined();
    });

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
            content: 'Use $smile face',
            selection: { start: 8, end: 8 },
            expected: expectedActiveWord({
                word: '$smile',
                activeWord: '$smi',
                offset: 4,
                endOffset: 10,
            }),
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'resolves mention in mixed-trigger line',
            content: 'Hey @john, use $smile and /help',
            selection: { start: 9, end: 9 },
            expected: expectedActiveWord({ word: '@john', offset: 4, endOffset: 9 }),
        },
        {
            name: 'resolves skill in mixed-trigger line',
            content: 'Hey @john, use $smile and /help',
            selection: { start: 21, end: 21 },
            expected: expectedActiveWord({ word: '$smile', offset: 15, endOffset: 21 }),
        },
        {
            name: 'resolves command in mixed-trigger line',
            content: 'Hey @john, use $smile and /help',
            selection: { start: 31, end: 31 },
            expected: expectedActiveWord({ word: '/help', offset: 26, endOffset: 31 }),
        },
        {
            name: 'handles long triggered token',
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

describe('findActiveWord token boundaries (EU-1)', () => {
    it.each<ActiveWordCase>([
        {
            name: 'keeps a dotted filename in the token',
            content: 'Look at @README.md',
            selection: { start: 18, end: 18 },
            expected: expectedActiveWord({ word: '@README.md', offset: 8, endOffset: 18 }),
        },
        {
            name: 'keeps a dotted package filename in the token',
            content: '@package.json',
            selection: { start: 13, end: 13 },
            expected: expectedActiveWord({ word: '@package.json', offset: 0, endOffset: 13 }),
        },
        {
            name: 'keeps a dotted path in the token',
            content: 'open @src/foo.ts',
            selection: { start: 16, end: 16 },
            expected: expectedActiveWord({ word: '@src/foo.ts', offset: 5, endOffset: 16 }),
        },
        {
            name: 'keeps the token open on the trailing dot',
            content: '@README.',
            selection: { start: 8, end: 8 },
            expected: expectedActiveWord({ word: '@README.', offset: 0, endOffset: 8 }),
        },
        {
            name: 'keeps a dotted slash command in the token',
            content: '/h.review',
            selection: { start: 9, end: 9 },
            expected: expectedActiveWord({ word: '/h.review', offset: 0, endOffset: 9 }),
        },
        {
            name: 'keeps a scoped plugin ref in the token',
            content: '@plugin:acme/formatter',
            selection: { start: 22, end: 22 },
            expected: expectedActiveWord({ word: '@plugin:acme/formatter', offset: 0, endOffset: 22 }),
        },
        {
            name: 'keeps a windows path in the token',
            content: '@C:\\repo\\src\\App.tsx',
            selection: { start: 20, end: 20 },
            expected: expectedActiveWord({ word: '@C:\\repo\\src\\App.tsx', offset: 0, endOffset: 20 }),
        },
    ])('$name', assertFindCase);

    it('resolves the same boundaries whether the cursor is before or after the dot', () => {
        const content = 'open @src/foo.ts here';
        const beforeDot = findActiveWord(content, { start: 13, end: 13 }, ALL_KINDS);
        const afterDot = findActiveWord(content, { start: 14, end: 14 }, ALL_KINDS);

        expect(beforeDot?.offset).toBe(5);
        expect(beforeDot?.endOffset).toBe(16);
        expect(afterDot?.offset).toBe(5);
        expect(afterDot?.endOffset).toBe(16);
    });

    it.each<ActiveWordCase>([
        {
            name: 'does not absorb a trailing space into the token',
            content: 'Hello @user ',
            selection: { start: 12, end: 12 },
            expected: undefined,
        },
        {
            name: 'does not absorb a following word into the token',
            content: 'Hello @user more',
            selection: { start: 16, end: 16 },
            expected: undefined,
        },
        {
            name: 'does not reach across a newline for a trigger',
            content: '@user\nmore',
            selection: { start: 10, end: 10 },
            expected: undefined,
        },
    ])('$name', assertFindCase);

    it.each<ActiveWordCase>([
        {
            name: 'parses a quoted span containing a space',
            content: '@"my file.ts"',
            selection: { start: 13, end: 13 },
            expected: expectedActiveWord({ word: '@"my file.ts"', offset: 0, endOffset: 13 }),
        },
        {
            name: 'keeps an unterminated quoted span open',
            content: '@"my fi',
            selection: { start: 7, end: 7 },
            expected: expectedActiveWord({ word: '@"my fi', offset: 0, endOffset: 7 }),
        },
        {
            name: 'tracks the cursor inside a quoted span',
            content: 'open @"my file.ts" now',
            selection: { start: 11, end: 11 },
            expected: expectedActiveWord({
                word: '@"my file.ts"',
                activeWord: '@"my f',
                offset: 5,
                endOffset: 18,
            }),
        },
        {
            name: 'ends a quoted span at the closing quote',
            content: '@"a b" tail',
            selection: { start: 6, end: 6 },
            expected: expectedActiveWord({ word: '@"a b"', offset: 0, endOffset: 6 }),
        },
        {
            name: 'treats a doubled quote inside a span as an escaped quote',
            content: '@"a"" b"',
            selection: { start: 8, end: 8 },
            expected: expectedActiveWord({ word: '@"a"" b"', offset: 0, endOffset: 8 }),
        },
        {
            name: 'does not open a quoted span for the skill trigger',
            content: '$"my skill"',
            selection: { start: 11, end: 11 },
            expected: undefined,
        },
        {
            name: 'never lets a quoted span cross a newline',
            content: '@"my file\nnext',
            selection: { start: 9, end: 9 },
            expected: expectedActiveWord({ word: '@"my file', offset: 0, endOffset: 9 }),
        },
    ])('$name', assertFindCase);

    it('falls back to an enclosing quoted span when a nearer trigger does not contain the cursor', () => {
        const content = '@"a @b c"';
        expect(findActiveWord(content, { start: 8, end: 8 }, ALL_KINDS)).toEqual(
            expectedActiveWord({ word: '@"a @b c"', activeWord: '@"a @b c', offset: 0, endOffset: 9 }),
        );
    });
});

describe('findActiveWord host eligibility (R-9, INV-1)', () => {
    // These mirror the four hosts' declared subsets. They are copies on purpose: importing a
    // composer host here would pull its whole screen subgraph into a token-scanner suite.
    // Sources: `SessionView.tsx`, `SessionParticipantComposer.tsx` /
    // `ExistingSessionAutomationComposer.tsx`, `useNewSessionScreenModel.tsx`.
    const SESSION_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'session', 'skill', 'slashCommand'];
    const PARTICIPANT_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'vendorPlugin', 'slashCommand'];
    const NEW_SESSION_KINDS: readonly ComposerSuggestionKindId[] = ['file', 'session', 'slashCommand'];

    it('offers the skill trigger only where a skill kind is eligible', () => {
        const content = 'Use $review';
        const selection = { start: 11, end: 11 };

        expect(findActiveWord(content, selection, SESSION_KINDS)).toEqual(
            expectedActiveWord({ word: '$review', offset: 4, endOffset: 11 }),
        );
        expect(findActiveWord(content, selection, PARTICIPANT_KINDS)).toBeUndefined();
        expect(findActiveWord(content, selection, NEW_SESSION_KINDS)).toBeUndefined();
    });

    it('offers the mention trigger only where a reference kind is eligible', () => {
        const content = 'Open @README.md';
        const selection = { start: 15, end: 15 };

        expect(findActiveWord(content, selection, PARTICIPANT_KINDS)).toEqual(
            expectedActiveWord({ word: '@README.md', offset: 5, endOffset: 15 }),
        );
        // A host with NO reference kind at all detects nothing on `@`.
        expect(findActiveWord(content, selection, ['slashCommand'])).toBeUndefined();
    });

    it('offers the mention trigger to the new-session composer, which has no session at all', () => {
        // `@` is live on a host with NO session, because neither of its reference kinds there is
        // session state: the session list is a server-level projection and a file search is
        // machine+folder addressed. `@` is one trigger shared by several kinds (INV-1), so
        // eligibility is what decides — never the character, and never which host is asking.
        expect(findActiveWord('Continue @session:fix', { start: 21, end: 21 }, NEW_SESSION_KINDS)).toEqual(
            expectedActiveWord({ word: '@session:fix', offset: 9, endOffset: 21 }),
        );
    });

    it('still offers slash commands to the new-session composer', () => {
        expect(findActiveWord('/h.review', { start: 9, end: 9 }, NEW_SESSION_KINDS)).toEqual(
            expectedActiveWord({ word: '/h.review', offset: 0, endOffset: 9 }),
        );
    });

    it('detects nothing when the host declares no kinds', () => {
        expect(findActiveWord('Open @README.md', { start: 15, end: 15 }, [])).toBeUndefined();
    });
});

describe('findActiveWord input methods (plan 7.3)', () => {
    it('resolves offsets in UTF-16 code units when the token contains astral characters', () => {
        // "🙂" is a surrogate pair: two UTF-16 code units.
        const content = 'see @🙂-notes.md';
        const result = findActiveWord(content, { start: content.length, end: content.length }, ALL_KINDS);

        expect(result?.offset).toBe(4);
        expect(result?.endOffset).toBe(content.length);
        expect(content.slice(result!.offset, result!.endOffset)).toBe(result?.word);
        expect(result?.word).toBe('@🙂-notes.md');
    });

    it('tracks a token whose prefix ends mid surrogate pair without corrupting the slice', () => {
        const content = 'see @🙂';
        // Cursor between the high and low surrogate — platforms can report this transiently.
        const result = findActiveWord(content, { start: 6, end: 6 }, ALL_KINDS);

        expect(result?.offset).toBe(4);
        expect(result?.activeLength).toBe(2);
        expect(result?.endOffset).toBe(7);
        expect(result?.word).toBe('@🙂');
    });

    it('detects a partially composed IME token', () => {
        const content = 'メモ @日本';
        const result = findActiveWord(content, { start: content.length, end: content.length }, ALL_KINDS);

        expect(result?.word).toBe('@日本');
        expect(result?.offset).toBe(3);
    });

    it('detects a mention inside right-to-left text', () => {
        const content = 'שלום @README.md';
        const result = findActiveWord(content, { start: content.length, end: content.length }, ALL_KINDS);

        expect(result?.word).toBe('@README.md');
        expect(result?.offset).toBe(5);
    });

    it('treats a non-breaking space as a token boundary', () => {
        const content = 'hi\u00A0@user';
        const result = findActiveWord(content, { start: content.length, end: content.length }, ALL_KINDS);

        expect(result?.word).toBe('@user');
        expect(result?.offset).toBe(3);
    });

    it('detects the token under the cursor after a paste lands mid-text', () => {
        // Pasting "@src/foo.ts " into "open |now" leaves the cursor after the pasted run.
        const content = 'open @src/foo.ts now';
        const result = findActiveWord(content, { start: 16, end: 16 }, ALL_KINDS);

        expect(result?.word).toBe('@src/foo.ts');
        expect(result?.endOffset).toBe(16);
    });

    it('detects the token again after an undo restores earlier text', () => {
        const restored = 'open @src/foo';
        const result = findActiveWord(restored, { start: restored.length, end: restored.length }, ALL_KINDS);

        expect(result?.word).toBe('@src/foo');
    });
});
