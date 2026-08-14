import { Fragment, useEffect, useRef, useState } from 'react';
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

export const DESKTOP_REVEAL_INTERSECTION_OPTIONS = {
    threshold: 0.22,
    rootMargin: '0px 0px -18% 0px',
} satisfies IntersectionObserverInit;

export const MOBILE_REVEAL_INTERSECTION_OPTIONS = {
    threshold: 0.01,
    rootMargin: '0px 0px 20% 0px',
} satisfies IntersectionObserverInit;

export function resolveRevealIntersectionOptions(isMobilePointer: boolean): IntersectionObserverInit {
    return isMobilePointer ? MOBILE_REVEAL_INTERSECTION_OPTIONS : DESKTOP_REVEAL_INTERSECTION_OPTIONS;
}

function hasMobilePointer(): boolean {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * Word-by-word reveal port from introvid.html:
 *   opacity 0→1, blur 10px→0, translateY 18px→0, scale 0.94→1,
 *   each word staggered by `stagger` ms.
 *
 * Animation only fires once the element is comfortably inside the viewport
 * (not at the bottom edge) — driven by a generous rootMargin so the user has
 * time to read the line as it lands instead of catching the tail end.
 *
 * Spaces between words are rendered as plain text nodes between spans so
 * inline-block whitespace collapsing doesn't merge words together.
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
    const ref = useRef<HTMLElement | null>(null);
    const [armed, setArmed] = useState(!inView);

    useEffect(() => {
        if (!inView || armed) return;
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        setArmed(true);
                        observer.disconnect();
                    }
                }
            },
            resolveRevealIntersectionOptions(hasMobilePointer()),
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [inView, armed]);

    const lines = text.replace(/\s*~~~\s*/g,String.fromCharCode(160)).split('\n');

    return (
        <Tag ref={ref as never} className={clsx('text-balance', className)}>
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
                                        // the state the PRERENDERED html ships with (effects never
                                        // run on the server), so it needs a named hook the
                                        // <noscript> stylesheet in index.html can force visible.
                                        // A shared utility class cannot be overridden that way
                                        // without hitting every other use of it.
                                        className={armed ? 'reveal-word' : 'reveal-word-idle'}
                                        style={armed ? ({ ['--delay' as string]: `${delay + flatIdx * stagger}ms` } as never) : undefined}
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
