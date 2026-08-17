import { Fragment } from 'react';

import { useSiteData } from '../i18n/siteData';
import { segmentWords } from '../i18n/segmentWords';

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
    /**
     * What to emit after this span. A space for Latin, nothing between CJK
     * characters — segmentWords decides, because inserting spaces between
     * Chinese characters is visibly wrong.
     */
    joiner: string;
    small?: boolean;
    gradient?: boolean;
};

/** A run of words that must never be split across two lines. */
type Group = { words: ReadonlyArray<WordSpec> };

const BASE_DELAY = 120;
const STAGGER = 45;

const GRADIENT_STYLE = {
    // The two stops are PINNED to the content box (see the padding note below).
    // Without explicit stop positions the gradient sizes itself to the padding
    // box, so adding padding stretched it and flattened the visible band.
    backgroundImage:
        'linear-gradient(to bottom, var(--fg-primary) 0.2em, var(--fg-primary-soft) calc(0.2em + 1lh))',
    backgroundClip: 'text',
    WebkitBackgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    // Descenders were being cut off — the y in "Everywhere", the y in "you".
    //
    // `background-clip: text` paints the gradient across the element's PADDING
    // BOX and then clips it to the glyph shapes. These spans are
    // `display: inline-block` because the reveal animation transforms them, so
    // their box is only one line tall, and a line box is SHORTER THAN THE FONT.
    // Glyph area outside the box has no background painted under it, and with
    // `color: transparent` there is nothing else to draw, so the overflowing
    // part of the glyph vanished along a clean horizontal line.
    //
    // THE GOVERNING LINE-HEIGHT IS 1.02, FROM `.font-display` (globals.css:514)
    // — not the `leading-[1.06]` on the h1 below. Both selectors are
    // specificity (0,1,0) and `.font-display` is emitted later, so it wins.
    // (`tracking-[-0.025em]` on the h1 loses to the same rule, which is why
    // neither utility is on the element any more: they rendered nothing.)
    //
    // Measured, not guessed. Inter Tight (public/fonts/
    // inter-tight-latin-var.woff2, unitsPerEm 2048) has hhea/sTypo ascent
    // 0.9688em and descent 0.2412em — a 1.2100em content area inside a 1.02em
    // box. Half-leading is therefore NEGATIVE, -0.0950em, and the baseline
    // lands 0.8738em down: 0.1463em of room below it for a glyph descending up
    // to 0.2412em, and 0.8738em of room above for ink reaching yMax 1.0908em.
    // The tail of the y overflowed by ~0.06em.
    //
    // Padded on BOTH sides on purpose. The bottom is what was visibly broken,
    // but the top has the same defect and more headroom to lose: an accented
    // capital — É, Ä, Ō — overflows by up to 0.217em, and this string comes
    // from the locale catalogue, so a translator introduces one with no code
    // change. Fixing only the side that happened to break in English would
    // hand the bug to the first language that capitalises an accent.
    //
    // Extend the painted box and take the same amount back out of the layout:
    // the margin box is unchanged, so line boxes and baselines do not move.
    paddingBlock: '0.2em',
    marginBlock: '-0.2em',
} as const;

/**
 * NOT `text.split(/\s+/)`. Chinese and Japanese contain no spaces, so a split on
 * whitespace returned the whole line as ONE unit — and because WordsLine wraps
 * every group in `white-space: nowrap`, that unit could not wrap at all and ran
 * off the viewport. segmentWords gives CJK real break opportunities and returns
 * exactly what the old split returned for Latin text.
 */
function words(text: string, extra?: Omit<WordSpec, 'text' | 'joiner'>): WordSpec[] {
    return segmentWords(text).map((unit) => ({ text: unit.text, joiner: unit.joiner, ...extra }));
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
                                    {word.joiner}
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
    const { pageProse: { HERO } } = useSiteData();

    const lineOne = enumerationGroups(HERO.headlineLineOne);
    const named = enumerationGroups(HERO.headlineLineTwo);
    const aside = HERO.headlineLineTwoAside.trim();
    const lineTwo: Group[] = aside
        ? [...named, { words: words(aside, { small: true }) }]
        : named;
    const lineThree: Group[] = [{ words: words(HERO.headlineLineThree, { gradient: true }) }];

    const lineTwoStart = countWords(lineOne);
    const lineThreeStart = lineTwoStart + countWords(lineTwo);

    return (
        <h1 className="font-display text-balance text-[42px] font-normal sm:text-[44px] md:text-[48px] lg:text-[58px] xl:text-[64px]">
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
