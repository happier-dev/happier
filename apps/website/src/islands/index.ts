/**
 * The islands runtime: mount the interactive widgets, leave the prose alone.
 *
 * WHAT THIS REPLACES. Every page currently ships `hydrateRoot(#root, <Page/>)`
 * (src/entries/_mount.tsx), which makes React the owner of the whole document.
 * Ownership is what forces the download: React re-derives the markup, so every
 * component that produced a node has to be in the browser's bundle. On this site
 * 21 source files contain a hook or an event handler (95 KB) and 66 contain
 * neither (410 KB) — and the 410 KB is already in the HTML, put there by
 * scripts/prerender.mjs, which is why a crawler needs no JavaScript at all.
 *
 * THE SHAPE.
 *
 *   server (src/entry-server.tsx → the page tree)
 *       <Island name="nav" component={Nav} props={{ … }} />
 *           renders <div data-island="nav" data-island-props="…"> around the
 *           component's normal SSR output. Everything else renders as it always
 *           did, so the prerendered HTML keeps every word it has today.
 *
 *   client (src/entries/<page>.tsx)
 *       mountIslands('en', { nav: Nav });
 *       armReveals();
 *           one React root per marked container; nothing else is React's.
 *
 * THE THREE THINGS THAT ARE NOT OBVIOUS, each argued where it lives:
 *
 *   props      cross as JSON in an attribute, and most islands should have none
 *              — src/islands/props.ts
 *   theme      stops being React context and becomes a module store, because it
 *              is the one mutable value read on both sides of the prose
 *              — src/islands/themeStore.ts
 *   reveals    are CSS keyframes armed by JS, and the arming is what breaks the
 *              moment prose stops being React's
 *              — src/islands/armReveals.ts
 *
 * The locale needs no mechanism at all: it is a build-time constant and each
 * entry already exists per (route, locale), so mountIslands wraps each island in
 * its own LocaleProvider with the value the entry names.
 */

export { Island } from './Island';
export { mountIslands, lazyIsland, type IslandMap, type IslandComponent, type IslandLoader } from './mountIslands';
export {
    ISLAND_ATTR,
    ISLAND_PROPS_ATTR,
    serialiseIslandProps,
    deserialiseIslandProps,
    type IslandProps,
    type JsonValue,
} from './props';
export { useTheme, setTheme, toggleTheme, type ThemeName, type ThemeStoreValue } from './themeStore';
export { armReveals } from './armReveals';
export {
    REVEAL_GROUP_ATTR,
    REVEAL_DELAY_ATTR,
    REVEAL_STAGGER_ATTR,
    REVEAL_IDLE_CLASS,
    REVEAL_ARMED_CLASS,
    REVEAL_DEFAULT_STAGGER_MS,
    DESKTOP_REVEAL_INTERSECTION_OPTIONS,
    MOBILE_REVEAL_INTERSECTION_OPTIONS,
    resolveRevealIntersectionOptions,
} from './revealOptions';
