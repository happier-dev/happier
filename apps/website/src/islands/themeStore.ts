import { useCallback, useSyncExternalStore } from 'react';

export type ThemeName = 'dark' | 'light';

/**
 * THE ONE PIECE OF STATE THAT GENUINELY CROSSES A PROSE BOUNDARY.
 *
 * Every other shared value on this site is a build-time constant — the locale,
 * the route, the copy — and a constant can simply be handed to each island
 * separately (src/islands/mountIslands.tsx does exactly that with the locale).
 * The theme cannot: it is written by a button in the nav and read, at the same
 * instant, by things that are nowhere near it.
 *
 *   src/components/TerminalBackground.tsx  full-viewport canvas, page root
 *   src/sections/HeroBackdrop.tsx          picks which backdrop image exists
 *   src/sections/ProviderScatter.tsx       stroke colour
 *   src/sections/CallToAction.tsx          backdrop id + overlay
 *   src/components/DownloadBadges.tsx      badge artwork variant
 *   src/components/HappierMark.tsx         cross-fades two logo PNGs
 *   src/components/ProviderMarkRow.tsx     mark colour
 *
 * Those sit in at least five separate islands with hundreds of lines of prose
 * between them, and React context does not cross a root boundary. `ThemeProvider`
 * in src/components/ThemeContext.tsx works today only because one `hydrateRoot`
 * call owns the entire page — it is, precisely, the context this change breaks.
 *
 * The replacement is a module-level store. Every island imports the same module,
 * so every island subscribes to the same value, and `useSyncExternalStore` gives
 * React the tearing guarantees that a hand-rolled `useState` + event listener
 * does not. `useTheme()` keeps its name and its shape, so the seven components
 * above do not change.
 *
 * TWO OF THOSE SEVEN SHOULD NOT BE HERE AT ALL. HappierMark and ProviderMarkRow
 * read the theme only to choose an opacity and a colour — `html.dark .x { … }`
 * expresses both, in CSS, for free, and neither component would then need to be
 * an island or ship any JavaScript. Moving them is not required for this to
 * work; it is required for the nav and the footer to stop being islands at all.
 */

const STORAGE_KEY = 'happier:theme';

/**
 * `<html class="dark">` IS THE STATE. localStorage is only where it is
 * remembered between visits.
 *
 * src/components/ThemeContext.tsx has it the other way round: `useState` seeded
 * from localStorage, with a `useEffect` writing the class afterwards. That
 * ordering has a bug independent of islands — the effect runs after hydration,
 * so a visitor who chose light last week is served the dark palette and watches
 * it flip once the bundle arrives. Reading the class instead makes the DOM the
 * single source of truth, which lets a synchronous inline script in index.html
 * set it before first paint (the same script that already adds `html.js`) and
 * lets every island read the settled answer with no flash and no ordering
 * between islands to get wrong.
 */
function readFromDocument(): ThemeName {
    const root = document.documentElement;
    if (root.classList.contains('light')) return 'light';
    if (root.classList.contains('dark')) return 'dark';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' ? 'light' : 'dark';
}

const listeners = new Set<() => void>();

/**
 * Cached because `useSyncExternalStore` calls `getSnapshot` on every render and
 * compares by `Object.is`. Recomputing from `classList` returns an equal string,
 * so a cache is not needed for correctness here — it is needed so a render never
 * touches the DOM, which is what keeps this safe to call from any island at any
 * time.
 */
let snapshot: ThemeName | null = null;

function getSnapshot(): ThemeName {
    /*
     * SSR-safe here rather than relying on the third argument to
     * useSyncExternalStore. React calls `getServerSnapshot` while rendering on
     * the server; preact/compat's implementation takes only (subscribe,
     * getSnapshot) and ignores it — so with the Preact alias in place the
     * build-time renderer called this function and died on `document is not
     * defined`, in the slicer, with no component named.
     *
     * Guarding the snapshot itself makes the store correct under either
     * renderer and removes a dependency on which one is aliased in.
     * getServerSnapshot stays for React's benefit and returns the same value.
     */
    if (typeof document === 'undefined') return 'dark';
    if (snapshot === null) snapshot = readFromDocument();
    return snapshot;
}

/**
 * What the build-time renderer sees, and therefore what the first client render
 * must also see or hydration mismatches.
 *
 * `'dark'` matches the current server behaviour (`readInitial()` returns 'dark'
 * when `window` is undefined) and matches the palette index.html ships. A
 * light-theme visitor's first painted frame is still corrected on the render
 * after hydration, exactly as it is today — the flash is removed by the inline
 * script named above, not by this function, which cannot know anything the
 * server did not.
 */
function getServerSnapshot(): ThemeName {
    return 'dark';
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function setTheme(next: ThemeName): void {
    if (getSnapshot() === next) return;
    snapshot = next;

    const root = document.documentElement;
    root.classList.toggle('dark', next === 'dark');
    root.classList.toggle('light', next === 'light');
    try {
        window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Safari private mode throws on setItem. The theme still applies for
        // this page; only the memory of it is lost, which is not worth an error.
    }

    for (const listener of listeners) listener();
}

export function toggleTheme(): void {
    setTheme(getSnapshot() === 'dark' ? 'light' : 'dark');
}

export type ThemeStoreValue = {
    theme: ThemeName;
    setTheme: (next: ThemeName) => void;
    toggle: () => void;
};

/**
 * Drop-in for the `useTheme()` in src/components/ThemeContext.tsx: same tuple,
 * same names, no provider required.
 *
 * Losing the provider is the point. `useTheme` used to throw outside
 * `ThemeProvider`, which under islands would mean every island that reads the
 * theme needs its own provider wrapper, and each provider would hold its OWN
 * `useState` — five islands, five independent themes, and a toggle that changes
 * the nav and nothing else. A module store has one value by construction.
 */
export function useTheme(): ThemeStoreValue {
    const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    const toggle = useCallback(() => toggleTheme(), []);
    return { theme, setTheme, toggle };
}

/**
 * Test seam. The store is module state, so a test that flips the theme leaks
 * into the next one; this is how a suite puts it back.
 */
export function __resetThemeStoreForTests(): void {
    snapshot = null;
    listeners.clear();
}
