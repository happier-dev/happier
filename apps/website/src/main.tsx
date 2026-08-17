import './styles/globals.css';
import { entrySlugFor } from './entries/_names';

/**
 * THE DEV SERVER'S ENTRY, AND NOTHING ELSE SHIPS FROM IT.
 *
 * In production every page has its own entry (src/entries/<slug>.tsx) and its
 * own chunk, and scripts/prerender.mjs writes the right <script> tag into each
 * prerendered file. A visitor to /security downloads /security's code plus the
 * shared react/vendor chunk — not the other twenty pages.
 *
 * `vite dev` has no prerenderer, so index.html has to point at something, and it
 * points here. This file's whole job is to look at `location.pathname` and load
 * the same entry the production HTML would have named. It is the ONE place the
 * mapping is done at runtime rather than at build time.
 *
 * WHY THE `import.meta.env.DEV` GUARD IS LOAD-BEARING. `import.meta.glob` is
 * expanded at build time into an object of dynamic imports — every entry on the
 * site. Under `vite build` DEV is replaced by the literal `false`, so Rollup
 * drops the whole block and, with it, one dynamic import per page; the chunk
 * this file produces is then the stylesheet and nothing else, which is exactly
 * what the shell HTML wants. Remove the guard and index.html becomes a
 * lazy-loader for the entire site again.
 *
 * The stylesheet import stays OUTSIDE the guard: it is what makes the dev server
 * serve CSS eagerly (a dev page that waited for a lazily imported entry to bring
 * its own CSS would flash unstyled), and in production it is the reason the
 * shell HTML gets its <link rel="stylesheet"> injected by Vite at all.
 */
if (import.meta.env.DEV) {
    const entries = import.meta.glob<{ default?: unknown }>('./entries/*.tsx');
    const key = `./entries/${entrySlugFor(window.location.pathname)}.tsx`;
    const load = entries[key];

    if (!load) {
        throw new Error(
            `No client entry for "${window.location.pathname}". Expected src/entries/` +
                `${entrySlugFor(window.location.pathname)}.tsx. Every route in ROUTES ` +
                '(src/routes.tsx) needs one — see src/entries/_names.ts.',
        );
    }

    void load();
}
