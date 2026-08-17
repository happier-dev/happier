import type { CtaLocation } from './events';

/**
 * Which block of the page an element sits in.
 *
 * ONE implementation, used by the delegated link listener AND by the components
 * that emit their own events (the copy button, the theme toggle, the FAQ
 * disclosure, the explorer tabs). Two implementations of "where was this?" is
 * two answers to the same PostHog question, and the version that disagrees is
 * always the one you are looking at.
 *
 * Resolution order:
 *   1. the nearest `[data-cta-location]` — for the cases where a control needs a
 *      finer name than its section (the nav sits inside the hero).
 *   2. the nearest `[data-section]` — the same attributes that drive the scroll
 *      funnel, so the page has one set of section names and not two.
 *   3. `hero`, because on this site an un-sectioned control is above the fold.
 */
export function locationOf(element: Element | null): CtaLocation {
    if (!element) return 'hero';
    const override = element.closest<HTMLElement>('[data-cta-location]');
    if (override?.dataset.ctaLocation) return override.dataset.ctaLocation as CtaLocation;
    const section = element.closest<HTMLElement>('[data-section]');
    return (section?.dataset.section as CtaLocation) ?? 'hero';
}
