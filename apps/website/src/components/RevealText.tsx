import { Fragment } from 'react';

import {
    REVEAL_ARMED_CLASS,
    REVEAL_DELAY_ATTR,
    REVEAL_GROUP_ATTR,
    REVEAL_IDLE_CLASS,
    REVEAL_STAGGER_ATTR,
} from '../islands/revealOptions';
import clsx from 'clsx';

type RevealTextProps = {
    text: string;
    className?: string;
    as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
    delay?: number;
    stagger?: number;
    /** When true the animation only plays once the element enters the viewport. */
    inView?: boolean;
};

/**
 * Re-exported, not redeclared.
 *
 * These lived here as their own copies while src/islands/revealOptions.ts held a
 * second set, and islands/revealOptions.test.ts existed only to assert the two
 * agreed — its docblock asked for exactly this change and for its own deletion
 * once made. A heading inside an island and a heading in prose have to start
 * animating at the same scroll position; one definition is a better guarantee of
 * that than a test.
 */
export {
    DESKTOP_REVEAL_INTERSECTION_OPTIONS,
    MOBILE_REVEAL_INTERSECTION_OPTIONS,
    resolveRevealIntersectionOptions,
} from '../islands/revealOptions';

/**
 * NO HOOKS. This component is prose, and prose is not React's any more.
 *
 * It used to own an IntersectionObserver and a `useState`, which meant every
 * heading on the site pulled React into the browser to do one thing: swap a
 * class when the words scrolled into view. Under islands that is both the wrong
 * shape and a trap — src/islands/armReveals.ts spells the trap out. `html.js`
 * makes `.reveal-word-idle` `opacity: 0` before first paint, so if nothing arms
 * a heading it stays permanently blank, the HTML is perfect, and no build check
 * would catch it.
 *
 * So the component now emits the CONTRACT and nothing else: the group carries
 * `data-reveal-group` plus its delay and stagger, each word carries the idle
 * class, and one non-React observer per page (armReveals) arms every group on
 * the page at once. armReveals computes `delay + index * stagger` over the
 * group's idle words in document order, which is the same flat index this
 * component used to compute across its lines — identical timing, no shared code.
 *
 * `inView={false}` still means "already armed": there is no group attribute and
 * the words ship in their animating class with the delay inline, exactly as
 * they did when the old `useState` was seeded to `true`.
 */
export function RevealText({
    text,
    className,
    as = 'span',
    delay = 0,
    stagger = 70,
    inView = true,
}: RevealTextProps) {
    const Tag = as;
    const lines = text.replace(/\s*~~~\s*/g, String.fromCharCode(160)).split('\n');

    const groupAttrs = inView
        ? {
              [REVEAL_GROUP_ATTR]: '',
              [REVEAL_DELAY_ATTR]: String(delay),
              [REVEAL_STAGGER_ATTR]: String(stagger),
          }
        : {};

    return (
        <Tag className={clsx('text-balance', className)} {...groupAttrs}>
            {lines.map((line, lineIdx) => {
                const words = line.split(' ');
                const wordsBefore = lines
                    .slice(0, lineIdx)
                    .reduce((acc, l) => acc + l.split(' ').length, 0);
                return (
                    <span key={lineIdx} className="block">
                        {words.map((word, wordIdx) => {
                            const flatIdx = wordsBefore + wordIdx;
                            const isLast = wordIdx === words.length - 1;
                            return (
                                <Fragment key={`${lineIdx}-${wordIdx}`}>
                                    <span
                                        // `reveal-word-idle`, not Tailwind's `opacity-0`: this is
                                        // the state the PRERENDERED html ships with, so it needs a
                                        // named hook the <noscript> stylesheet in index.html can
                                        // force visible. A shared utility class cannot be
                                        // overridden that way without hitting every other use.
                                        className={inView ? REVEAL_IDLE_CLASS : REVEAL_ARMED_CLASS}
                                        style={
                                            inView
                                                ? undefined
                                                : ({ ['--delay' as string]: `${delay + flatIdx * stagger}ms` } as never)
                                        }
                                    >
                                        {word}
                                    </span>
                                    {!isLast ? ' ' : ''}
                                </Fragment>
                            );
                        })}
                    </span>
                );
            })}
        </Tag>
    );
}
