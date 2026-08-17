import { StrictMode, type ComponentType } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import { LocaleProvider } from '../i18n';
import type { Locale } from '../i18n/locales';
import { ISLAND_ATTR, ISLAND_PROPS_ATTR, deserialiseIslandProps, type IslandProps } from './props';

/**
 * The client half of an island, and the thing that replaces
 * `hydrateRoot(document.getElementById('root'), <Page/>)`.
 *
 * Hydrating `#root` makes React the owner of every node on the page, and
 * ownership is what forces the download: React re-derives the markup, so every
 * component that produced a node has to be in the browser's bundle. On this site
 * 21 source files contain a hook or an event handler (95 KB) and 66 contain
 * neither (410 KB) — and that 410 KB is already in the HTML, put there by
 * scripts/prerender.mjs, which is why a crawler needs no JavaScript at all.
 * Sending it a second time as JavaScript buys nothing.
 *
 * This function walks the prerendered document instead, finds the handful of
 * containers the renderer marked, and gives React one root per container.
 * Everything between the containers stays as it was served.
 *
 * ONE ROOT PER ISLAND, NOT ONE ROOT WITH HOLES. React has no supported way to
 * own part of a subtree — `hydrateRoot` on a container assumes it rendered
 * everything inside it. Separate roots is not a workaround; it is the only shape
 * in which the prose can belong to nobody.
 */

/**
 * A component in an island map. Heterogeneous by construction — each island's
 * props are type-checked at its `<Island>` call site on the server, which is the
 * only place both the component and its props are known together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IslandRenderer = ComponentType<any>;

/**
 * An island whose code is fetched only when it is needed.
 *
 * This is the form that pays. An island named directly is in the entry's STATIC
 * import graph, so its code must arrive before the page can mount anything and
 * scripts/assert-perf-budget.mjs counts it against that route's budget. Wrapping
 * it in `lazyIsland` puts it behind a dynamic `import()` — off the critical
 * path, and excluded from the budget by the same rule that already excludes
 * posthog-js. src/components/TerminalBackground.tsx is the obvious first
 * candidate: 293 lines of canvas animation painting behind the whole page, none
 * of which needs to exist before the visitor has read the first screen.
 *
 *     mountIslands('en', {
 *         nav: Nav,
 *         'terminal-background': lazyIsland(() => import('../components/TerminalBackground')),
 *     });
 */
export type IslandLoader = {
    load: () => Promise<{ default: IslandRenderer } | IslandRenderer>;
};

export function lazyIsland(load: IslandLoader['load']): IslandLoader {
    return { load };
}

export type IslandComponent = IslandRenderer | IslandLoader;

export type IslandMap = Readonly<Record<string, IslandComponent>>;

/**
 * A component is a function; a loader is an object. That is the whole test, and
 * it is deliberately not a heuristic.
 *
 * The tempting version — "a function taking no arguments must be a loader" — is
 * wrong on this codebase and dangerously so: `Nav`, `Footer` and
 * `TerminalBackground` are all zero-parameter components, and calling one as a
 * loader would hand `mountOne` a ReactElement to render as a component.
 * `lazyIsland()` makes the caller say which they meant.
 */
function isLoader(value: IslandComponent): value is IslandLoader {
    return typeof value === 'object' && value !== null && typeof value.load === 'function';
}

function resolveComponent(loaded: { default: IslandRenderer } | IslandRenderer, name: string): IslandRenderer {
    if (typeof loaded === 'function') return loaded;
    if (loaded && typeof loaded === 'object' && typeof loaded.default === 'function') return loaded.default;
    throw new Error(
        `island "${name}": its loader resolved to something that is not a component. A module with ` +
            'a named export needs the name picking out: `() => import("./X").then((m) => m.X)`.',
    );
}

/**
 * Islands nested inside another island are React's, not ours.
 *
 * A section that is itself an island can contain a smaller one — a copy button
 * inside a stepper, a theme toggle inside a nav. The outer island's React tree
 * already renders it, so mounting a second root over the same DOM would leave
 * two copies of React fighting over the same nodes, and the symptom (a button
 * that answers one click twice) is close to impossible to read backwards. Only
 * containers with no island ancestor get a root.
 */
function isNested(container: Element): boolean {
    return container.parentElement?.closest(`[${ISLAND_ATTR}]`) != null;
}

function mountOne(container: Element, locale: Locale, name: string, Component: IslandRenderer): void {
    const props = deserialiseIslandProps(name, container.getAttribute(ISLAND_PROPS_ATTR));

    /**
     * The locale is passed in, never derived from `location.pathname`.
     *
     * Same rule src/entries/_mount.tsx already holds, for the reason set out in
     * the LocaleProvider docblock in src/i18n/index.tsx: the entry file exists
     * per (route, locale), so it knows the locale for certain, and re-deriving
     * it from the URL is a second source of truth that disagrees with the first
     * on exactly the pages nobody tests.
     *
     * ONE PROVIDER PER ISLAND rather than one around the page. Context cannot
     * cross a root boundary — and here it does not need to. The locale is a
     * build-time constant, not state anything mutates, so N copies of a value
     * that is identical in all of them cost a closure and agree by
     * construction. Shared MUTABLE state is the case that genuinely cannot be
     * done this way; see src/islands/themeStore.ts.
     */
    const tree = (
        <StrictMode>
            <LocaleProvider locale={locale} path={window.location.pathname}>
                <Component {...props} />
            </LocaleProvider>
        </StrictMode>
    );

    /**
     * A prerendered page has markup inside the container and must hydrate over
     * it. `vite dev` serves the shell with an empty `#root` and no islands at
     * all. Hydrating an empty container warns on every load, so fall back to a
     * fresh root rather than assuming which of the two produced this page.
     */
    if (container.firstChild) {
        hydrateRoot(container, tree);
    } else {
        createRoot(container).render(tree);
    }
}

/**
 * Mount every island the served HTML declares.
 *
 * `islands` lists ONLY the islands that page has. It must never be a shared map
 * of every island on the site: that map would import every island component,
 * every page entry would import the map, and the site would be back to one
 * bundle for all 21 pages — the exact regression src/entries/_names.ts exists to
 * prevent.
 *
 * An island in the HTML with no entry in the map is a hard failure, not a skip.
 * The two lists are written by hand in two files, and the only thing keeping
 * them in step is that disagreeing hurts immediately. A silent skip ships a page
 * whose copy button does nothing and whose theme toggle is dead, and nothing
 * anywhere says so.
 */
export function mountIslands(locale: Locale, islands: IslandMap): void {
    const containers = Array.from(document.querySelectorAll<HTMLElement>(`[${ISLAND_ATTR}]`));

    for (const container of containers) {
        if (isNested(container)) continue;

        const name = container.getAttribute(ISLAND_ATTR) ?? '';
        const entry = islands[name];
        if (!entry) {
            throw new Error(
                `This page renders <Island name="${name}"> but its client entry did not list ` +
                    `"${name}" in mountIslands(). Add it to the island map in src/entries/ — the ` +
                    'prerendered markup is on screen either way, but nothing in it responds.',
            );
        }

        if (isLoader(entry)) {
            void entry
                .load()
                .then((loaded) => mountOne(container, locale, name, resolveComponent(loaded, name)))
                .catch((error: unknown) => {
                    // The prose stays on screen; only this island is dead. Name
                    // it, or a failed chunk reads as a component bug.
                    console.error(`island "${name}" failed to load`, error);
                });
            continue;
        }

        mountOne(container, locale, name, entry);
    }
}

export type { IslandProps };
