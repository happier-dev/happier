import { Fragment } from 'react';

/**
 * Hero headline composed of three reveal lines, with a small "& 12+ more"
 * annotation next to "OpenCode, Pi" and a vertical text gradient on the
 * final "Everywhere you work." line.
 *
 * Each word is its own reveal span. Spaces are plain text nodes between
 * spans so inline-block whitespace collapsing doesn't merge words.
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
};

const LINE_ONE: ReadonlyArray<WordSpec> = [
    { text: 'Claude', gradient: true },
    { text: 'Code,', gradient: true },
    { text: 'Codex', gradient: true },
];
const LINE_TWO: ReadonlyArray<WordSpec> = [
    { text: 'OpenCode,', gradient: true },
    { text: 'Pi', gradient: true },
    { text: '& 12+ more', small: true },
];
const LINE_THREE: ReadonlyArray<WordSpec> = [
    { text: 'Everywhere' },
    { text: 'you' },
    { text: 'work.' },
];

const BASE_DELAY = 120;
const STAGGER = 70;

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

function WordsLine({ words, startIndex }: WordsLineProps) {
    return (
        <>
            {words.map((word, wordIdx) => {
                const delay = BASE_DELAY + (startIndex + wordIdx) * STAGGER;
                const isLast = wordIdx === words.length - 1;
                const nextIsSmall = !isLast && words[wordIdx + 1]?.small;
                const wordStyle: Record<string, unknown> = {
                    ['--delay']: `${delay}ms`,
                };
                if (word.small) {
                    // Match the subtitle's responsive size (16px → 18px on lg+)
                    // for visual consistency with the line below.
                    wordStyle.marginLeft = '0.55em';
                    wordStyle.letterSpacing = '-0.005em';
                    wordStyle.fontWeight = 500;
                    wordStyle.color = 'var(--muted)';
                }
                if (word.gradient) {
                    Object.assign(wordStyle, GRADIENT_STYLE);
                }
                return (
                    <Fragment key={wordIdx}>
                        <span
                            className={`reveal-word${word.small ? ' text-[16px] lg:text-[18px]' : ''}`}
                            style={wordStyle as never}
                        >
                            {word.text}
                        </span>
                        {!isLast && !nextIsSmall ? ' ' : ''}
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
        <h1 className="font-display text-balance text-[34px] font-normal leading-[1.06] tracking-[-0.025em] sm:text-[40px] md:text-[48px] lg:text-[58px] xl:text-[64px]">
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
