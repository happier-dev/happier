import { useEffect } from 'react';

import {
    SECTION_NAMES,
    trackComparisonViewed,
    trackSectionViewed,
    type SectionName,
} from './events';

/**
 * Sections that are also a named milestone in their own right.
 *
 * Keeping this here rather than inside src/sections/VsRemoteControl.tsx means
 * the objection-handling copy can be rewritten, moved or A/B-swapped without
 * anyone having to remember an analytics call buried in it.
 */
const MILESTONES: Partial<Record<SectionName, () => void>> = {
    'vs-remote-control': () => trackComparisonViewed({ subject: 'claude-code-remote-control' }),
    // /vs/codex-remote reaches the same milestone through its own table, so the
    // two comparisons stay ONE event broken down by `subject` rather than two
    // events nobody remembers to compare. There is no 'codex-concession'
    // milestone for the same reason there is no 'rc-concession' one: reading a
    // concession is read depth, not a decision.
    'codex-table': () => trackComparisonViewed({ subject: 'codex-remote' }),
};

/**
 * Turns the single-page scroll into a nine-step funnel.
 *
 * One observer for the whole document rather than one hook per section: the page
 * already runs IntersectionObservers for the showcase reveal
 * (HeroShowcase.tsx:30) and the feature panels, and adding nine more to fire
 * once each is a waste of a scroll frame on a page whose Core Web Vitals we are
 * also measuring.
 *
 * Sections are found by `[data-section]`, so adding a section to the page is one
 * attribute plus one entry in SECTION_NAMES — and events.test.ts fails if a
 * `data-section` value is not in that list.
 */
export function useSectionViewed(): void {
    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return;

        const seen = new Set<string>();
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-section]'));
        if (nodes.length === 0) return;

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const name = (entry.target as HTMLElement).dataset.section;
                    if (!name || seen.has(name)) continue;
                    if (!(SECTION_NAMES as readonly string[]).includes(name)) continue;
                    seen.add(name);
                    trackSectionViewed({ section: name as SectionName });
                    MILESTONES[name as SectionName]?.();
                    observer.unobserve(entry.target);
                }
            },
            // Fires on first intersection. A single 0.5 threshold would never
            // fire for a section taller than the viewport (the feature wall is),
            // and rootMargin trims the last sliver so a section that merely
            // grazes the fold during a fast scroll does not count as read.
            { threshold: 0.01, rootMargin: '0px 0px -15% 0px' },
        );

        for (const node of nodes) observer.observe(node);
        return () => observer.disconnect();
    }, []);
}
