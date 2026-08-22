import {
    REVEAL_ARMED_CLASS,
    REVEAL_PANEL_ARMED_CLASS,
    REVEAL_PANEL_ATTR,
    REVEAL_DEFAULT_STAGGER_MS,
    REVEAL_DELAY_ATTR,
    REVEAL_GROUP_ATTR,
    REVEAL_IDLE_CLASS,
    REVEAL_STAGGER_ATTR,
    resolveRevealIntersectionOptions,
} from './revealOptions';

/**
 * THE FAILURE THAT MAKES ISLANDS DANGEROUS ON THIS SITE, AND ITS FIX.
 *
 * src/styles/globals.css:539 says:
 *
 *     html.js .reveal-word-idle { opacity: 0 }
 *
 * and index.html adds `js` to `<html>` synchronously, in `<head>`, before first
 * paint. So on any browser with JavaScript enabled every word of every
 * <RevealText> heading in the prerendered HTML starts INVISIBLE, and the only
 * thing that ever makes it visible is React: `RevealText`'s IntersectionObserver
 * swapping the class to `.reveal-word`, whose keyframes animate opacity to 1.
 *
 * That is fine while one `hydrateRoot` owns the page. The moment the prose stops
 * being React's, those headings have nothing left to arm them and they stay at
 * `opacity: 0` forever. The `<noscript>` block in index.html does not help — JS
 * is enabled, that is the whole problem. A homepage cut into islands without
 * this file loads with its section headings permanently blank, on every
 * browser, and the HTML is perfect so nothing in the build would catch it.
 *
 * WHY NOT PURE CSS. `animation-timeline: view()` would make the whole thing free
 * and delete this file. It is newly available (Chrome 115, Safari 26, Firefox
 * 144) and the fallback for anything older is not "no animation" but "invisible
 * text", because of the `html.js` rule above. That trade is only acceptable
 * alongside changing the idle default, which is a bigger decision about what a
 * slow client sees. Until then: ~40 lines, no React, one observer.
 *
 * WHY NOT JUST DELETE THE `html.js` RULE. Because it is doing real work — it is
 * what stops the reveal from being a flash of already-visible text that then
 * re-animates. Deleting it makes every heading pop twice.
 */

function hasMobilePointer(): boolean {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function numberAttr(group: Element, attr: string, fallback: number): number {
    const raw = group.getAttribute(attr);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Swap a group's words from their idle class to their animating one.
 *
 * The per-word delay is computed from the word's position among the group's idle
 * words, which is the same flat index `RevealText` computes across its lines
 * (`wordsBefore + wordIdx`) because `querySelectorAll` returns document order.
 * The two therefore produce identical timing without sharing any code — worth
 * knowing, because it means an island rendering RevealText and a prose heading
 * armed from here animate the same way.
 */
function arm(group: Element): void {
    if (group.hasAttribute(REVEAL_PANEL_ATTR)) {
        group.classList.add(REVEAL_PANEL_ARMED_CLASS);
        return;
    }

    const delay = numberAttr(group, REVEAL_DELAY_ATTR, 0);
    const stagger = numberAttr(group, REVEAL_STAGGER_ATTR, REVEAL_DEFAULT_STAGGER_MS);
    const words = group.querySelectorAll<HTMLElement>(`.${REVEAL_IDLE_CLASS}`);

    words.forEach((word, index) => {
        word.style.setProperty('--delay', `${delay + index * stagger}ms`);
        word.classList.remove(REVEAL_IDLE_CLASS);
        word.classList.add(REVEAL_ARMED_CLASS);
    });
}

/**
 * Arm every reveal group in `root` as it scrolls into view.
 *
 * Returns a teardown, so a test or a hot reload can stop observing. Call it once
 * per page from the entry, next to `mountIslands` — NOT from inside an island:
 * the groups it exists for are the ones no island owns.
 *
 * Fails open in every direction. No IntersectionObserver (old Safari, some
 * embedded webviews), reduced motion, or a group with no words: arm immediately
 * and let the CSS decide whether anything moves. `.reveal-word` under
 * `prefers-reduced-motion` already resolves to opacity 1 with no animation
 * (src/styles/globals.css:578), so "arm immediately" is the correct behaviour
 * there and not merely the safe one. The one outcome this function must never
 * produce is a word left in `.reveal-word-idle`.
 */
export function armReveals(root: ParentNode = document): () => void {
    /*
     * Two kinds of reveal, one observer.
     *
     * Word groups swap a class per word; panels take one class on themselves
     * (src/sections/AlternatingFeatures.tsx). They are armed together because
     * they fail together: `html.js` sets BOTH `.reveal-word-idle` and `.fpanel`
     * to `opacity: 0`, so anything this function does not reach is not
     * un-animated, it is invisible. The panels were exactly that after the
     * islands migration — the section is prose, so the `useState` that used to
     * add `is-in` never ran again and the feature cards were a blank column.
     */
    const groups = Array.from(root.querySelectorAll<HTMLElement>(`[${REVEAL_GROUP_ATTR}]`));
    const panels = Array.from(root.querySelectorAll<HTMLElement>(`[${REVEAL_PANEL_ATTR}]`));
    const targets = [...groups, ...panels];
    if (targets.length === 0) return () => {};

    if (typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) {
        for (const target of targets) arm(target);
        return () => {};
    }

    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            arm(entry.target);
            observer.unobserve(entry.target);
        }
    }, resolveRevealIntersectionOptions(hasMobilePointer()));

    for (const target of targets) observer.observe(target);

    /*
     * THE BACKSTOP, and why it is not belt-and-braces.
     *
     * This file's own contract is "the one outcome this function must never
     * produce is a word left in `.reveal-word-idle`", because `html.js` makes
     * that class `opacity: 0` — an unarmed heading is not an un-animated
     * heading, it is an invisible one. Everything above fails open for the
     * conditions it can TEST for (no IntersectionObserver, reduced motion, an
     * empty group). It cannot test for an observer that exists, accepts the
     * observe() call, and then never fires — which is a real state: some
     * embedded webviews, some headless and automation contexts, and any
     * environment that never composites the page.
     *
     * So: after a delay far longer than any legitimate reveal, arm whatever is
     * still idle. A visitor on a working browser has seen every one of these
     * animate long before it runs and it does nothing; a visitor on a browser
     * where the observer is inert gets the text, un-animated, instead of a blank
     * page. That is the correct direction to fail in, and it is the only
     * direction this file is allowed to fail in.
     */
    const backstop = window.setTimeout(() => {
        for (const target of targets) {
            const unarmed = target.hasAttribute(REVEAL_PANEL_ATTR)
                ? !target.classList.contains(REVEAL_PANEL_ARMED_CLASS)
                : target.querySelector(`.${REVEAL_IDLE_CLASS}`) !== null;
            if (unarmed) arm(target);
        }
    }, 4000);

    return () => {
        window.clearTimeout(backstop);
        observer.disconnect();
    };
}
