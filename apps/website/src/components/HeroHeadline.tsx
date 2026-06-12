import { Fragment } from 'react';

/**
 * Hero headline composed of three reveal lines, with a small "& 12+ more"
 * annotation next to "OpenCode, Pi" and a vertical text gradient on the
 * final "Everywhere you work." line.
 *
 * Each word is its own reveal span. Spaces are plain text nodes between
 * spans so inline-block whitespace collapsing doesn't merge words.
 *
 * Multi-word provider names (e.g. "Claude Code") are grouped inside a
 * `white-space: nowrap` wrapper so the words inside cannot be split across
 * two lines. The whole group still wraps as a unit when there isn't room.
 *
 * The gradient on the third line is applied PER WORD rather than on a
 * parent span — `background-clip: text` is unreliable when descendants are
 * `display: inline-block` (as our reveal spans must be for transforms).
 * Per-word gives each word its own bg-clip context and renders reliably
 * across browsers; visually it reads as one continuous gradient because
 * the words share a baseline and line height.
 */

type WordSpec = {
    text: string;
    small?: boolean;
    gradient?: boolean;
    /** When true, this word stays on the same line as the previous word. */
    joinPrev?: boolean;
};

const LINE_ONE: ReadonlyArray<WordSpec> = [
    { text: 'Claude', gradient: true },
    { text: 'Code,', gradient: true, joinPrev: true },
    { text: 'Codex', gradient: true },
];
const LINE_TWO: ReadonlyArray<WordSpec> = [
    { text: 'OpenCode, Pi,', gradient: true },
    { text: 'Cursor,', gradient: true },
    { text: '& more', small: true },
];
const LINE_THREE: ReadonlyArray<WordSpec> = [
    { text: 'Everywhere' },
    { text: 'you' },
    { text: 'go.' },
];

const BASE_DELAY = 120;
const STAGGER = 45;

const GRADIENT_STYLE = {
    backgroundImage:
        'linear-gradient(to bottom, var(--fg-primary), var(--fg-primary-soft))',
    backgroundClip: 'text',
    WebkitBackgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
} as const;

type WordsLineProps = {
    words: ReadonlyArray<WordSpec>;
    startIndex: number;
};

function renderWord(word: WordSpec, absoluteIndex: number) {
    const delay = BASE_DELAY + absoluteIndex * STAGGER;
    const wordStyle: Record<string, unknown> = {
        ['--delay']: `${delay}ms`,
    };
    if (word.small) {
        wordStyle.marginLeft = '0.55em';
        wordStyle.letterSpacing = '-0.005em';
        wordStyle.fontWeight = 500;
        wordStyle.color = 'var(--muted)';
    }
    if (word.gradient) {
        Object.assign(wordStyle, GRADIENT_STYLE);
    }
    return (
        <span
            className={`reveal-word${word.small ? ' text-[16px] lg:text-[18px]' : ''}`}
            style={wordStyle as never}
        >
            {word.text}
        </span>
    );
}

function WordsLine({ words, startIndex }: WordsLineProps) {
    // Group consecutive words that should stay on the same line.
    // Each group becomes a `white-space: nowrap` span so its words cannot
    // be split across two lines, regardless of inline-block break behavior.
    type Group = { startIdx: number; items: WordSpec[] };
    const groups: Group[] = [];
    words.forEach((word, idx) => {
        if (word.joinPrev && groups.length > 0) {
            groups[groups.length - 1].items.push(word);
        } else {
            groups.push({ startIdx: idx, items: [word] });
        }
    });

    return (
        <>
            {groups.map((group, groupIdx) => {
                const isLastGroup = groupIdx === groups.length - 1;
                const nextGroupFirstWord = !isLastGroup ? groups[groupIdx + 1].items[0] : undefined;
                const separator = isLastGroup || nextGroupFirstWord?.small ? '' : ' ';
                return (
                    <Fragment key={groupIdx}>
                        <span style={{ whiteSpace: 'nowrap' }}>
                            {group.items.map((word, i) => {
                                const absoluteIndex = startIndex + group.startIdx + i;
                                const isLastInGroup = i === group.items.length - 1;
                                return (
                                    <Fragment key={i}>
                                        {renderWord(word, absoluteIndex)}
                                        {!isLastInGroup ? ' ' : ''}
                                    </Fragment>
                                );
                            })}
                        </span>
                        {separator}
                    </Fragment>
                );
            })}
        </>
    );
}

export function HeroHeadline() {
    const line2Start = LINE_ONE.length;
    const line3Start = LINE_ONE.length + LINE_TWO.length;
    return (
        <h1 className="font-display text-balance text-[42px] font-normal leading-[1.06] tracking-[-0.025em] sm:text-[44px] md:text-[48px] lg:text-[58px] xl:text-[64px]">
            <span className="block">
                <WordsLine words={LINE_ONE} startIndex={0} />
            </span>
            <span className="block">
                <WordsLine words={LINE_TWO} startIndex={line2Start} />
            </span>
            <span className="block" style={{ fontWeight: 500, marginTop: '15px' }}>
                <WordsLine words={LINE_THREE} startIndex={line3Start} />
            </span>
        </h1>
    );
}
