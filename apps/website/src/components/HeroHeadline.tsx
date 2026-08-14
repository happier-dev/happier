import { Fragment } from 'react';

import { useT } from '../i18n';

/**
 * Hero headline: three reveal lines, a small aside next to line two, and a
 * vertical text gradient on the final line.
 *
 * COPY LIVES IN src/i18n/messages/en.ts, NOT HERE. This file used to hold its
 * own hardcoded word list saying "& 12+ more" while en.ts said "& more" after a
 * different set of names — two sources, two different agent counts, one of them
 * wrong. The component now parses whatever the locale gives it, so the count is
 * asserted in exactly one place and src/data/copyClaims.test.ts can guard it.
 *
 * Each word is its own reveal span. Spaces are plain text nodes between spans so
 * inline-block whitespace collapsing doesn't merge words.
 *
 * Multi-word provider names ("Claude Code") are grouped inside a
 * `white-space: nowrap` wrapper so the words inside cannot be split across two
 * lines. The whole group still wraps as a unit when there isn't room. Groups are
 * derived from the commas in the string — `,` in English, `、` in Chinese — so a
 * translator moves a break by moving a comma, with no code change.
 *
 * The gradient on the third line is applied PER WORD rather than on a parent
 * span — `background-clip: text` is unreliable when descendants are
 * `display: inline-block` (as our reveal spans must be for transforms). Per-word
 * gives each word its own bg-clip context and renders reliably across browsers;
 * visually it reads as one continuous gradient because the words share a
 * baseline and line height.
 */

type WordSpec = {
    text: string;
    small?: boolean;
    gradient?: boolean;
};

/** A run of words that must never be split across two lines. */
type Group = { words: ReadonlyArray<WordSpec> };

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

function words(text: string, extra?: Omit<WordSpec, 'text'>): WordSpec[] {
    return text
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({ text: word, ...extra }));
}

/**
 * Split an enumeration into nowrap groups, one per comma-delimited item, keeping
 * the comma attached to the item it follows.
 *
 * Deliberately NOT a lookbehind (splitting on `(?<=[,、])` and trailing space):
 * Safari only shipped regex lookbehind in 16.4, and a lookbehind in a
 * module-scope regex literal is a parse-time SyntaxError on older engines — it
 * would take the whole bundle down, not just the headline.
 */
function enumerationGroups(line: string, extra?: Omit<WordSpec, 'text'>): Group[] {
    const segments = line.match(/[^,、]+[,、]?/g) ?? [];
    return segments
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => ({ words: words(segment, extra) }));
}

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

function WordsLine({ groups, startIndex }: { groups: ReadonlyArray<Group>; startIndex: number }) {
    let cursor = startIndex;
    const positioned = groups.map((group) => {
        const at = cursor;
        cursor += group.words.length;
        return { group, at };
    });

    return (
        <>
            {positioned.map(({ group, at }, groupIdx) => {
                const isLastGroup = groupIdx === positioned.length - 1;
                const next = !isLastGroup ? positioned[groupIdx + 1].group : undefined;
                // The small aside sets its own `margin-left`, so an extra space
                // in front of it would double the gap.
                const separator = isLastGroup || next?.words[0]?.small ? '' : ' ';
                return (
                    <Fragment key={groupIdx}>
                        <span style={{ whiteSpace: 'nowrap' }}>
                            {group.words.map((word, i) => (
                                <Fragment key={i}>
                                    {renderWord(word, at + i)}
                                    {i === group.words.length - 1 ? '' : ' '}
                                </Fragment>
                            ))}
                        </span>
                        {separator}
                    </Fragment>
                );
            })}
        </>
    );
}

function countWords(groups: ReadonlyArray<Group>): number {
    return groups.reduce((total, group) => total + group.words.length, 0);
}

export function HeroHeadline() {
    const t = useT();

    const lineOne = enumerationGroups(t.hero.headlineLineOne);
    const named = enumerationGroups(t.hero.headlineLineTwo);
    const aside = t.hero.headlineLineTwoAside.trim();
    const lineTwo: Group[] = aside
        ? [...named, { words: words(aside, { small: true }) }]
        : named;
    const lineThree: Group[] = [{ words: words(t.hero.headlineLineThree, { gradient: true }) }];

    const lineTwoStart = countWords(lineOne);
    const lineThreeStart = lineTwoStart + countWords(lineTwo);

    return (
        <h1 className="font-display text-balance text-[42px] font-normal leading-[1.06] tracking-[-0.025em] sm:text-[44px] md:text-[48px] lg:text-[58px] xl:text-[64px]">
            <span className="block">
                <WordsLine groups={lineOne} startIndex={0} />
            </span>
            <span className="block">
                <WordsLine groups={lineTwo} startIndex={lineTwoStart} />
            </span>
            <span className="block" style={{ fontWeight: 500, marginTop: '15px' }}>
                <WordsLine groups={lineThree} startIndex={lineThreeStart} />
            </span>
        </h1>
    );
}
