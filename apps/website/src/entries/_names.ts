/**
 * URL → client entry. One rule, three readers.
 *
 * A visitor to /security must download /security's code and nothing else, which
 * means the build needs one Rollup input per prerendered page and the shipped
 * HTML for that page needs to point at the right one. Three places have to agree
 * on which file that is:
 *
 *   vite.config.ts      discovers the entry FILES on disk (src/entries/*.tsx)
 *                       and turns them into Rollup inputs. It never computes a
 *                       name — it reads the directory, so it cannot drift.
 *   src/entry-server.tsx  computes the entry each route in ROUTES needs, and
 *                       hands it to the prerenderer on the route manifest.
 *   src/main.tsx        picks the entry for `location.pathname` in `vite dev`,
 *                       where there is no prerenderer and no manifest.
 *
 * The last two call THIS function, and the build fails loudly when the file the
 * rule names is not on disk (see scripts/prerender.mjs). That is the whole
 * synchronisation mechanism: adding a route to src/routes.tsx without adding its
 * entry here breaks the build with a message naming the file to create, instead
 * of silently shipping a page that hydrates nothing.
 *
 * NOT DERIVED FROM A GLOB OF ROUTES. src/routes.tsx pulls in every page
 * component and every data module by construction — that is the 133 KB of copy
 * this split exists to stop shipping to everyone — so no client entry may import
 * it, directly or transitively. The entries are therefore hand-written files
 * that each name exactly one page, and this rule is what keeps them addressable.
 */

/**
 * The `<slug>` in `src/entries/<slug>.tsx` for a served path.
 *
 * The path is the one the route manifest emits, INCLUDING any locale prefix, so
 * localisation needs no special case: `/zh-Hans/security` asks for
 * `src/entries/zh-Hans--security.tsx`. Nothing here counts routes or locales.
 *
 *   /                          → home
 *   /agents                    → agents
 *   /agents/claude-code        → agents--claude-code
 *   /features/usage-limits     → features--usage-limits
 *   /zh-Hans/security          → zh-Hans--security
 *
 * `--` separates path segments rather than `-`, so a two-segment path can never
 * collide with a one-segment path that happens to contain a hyphen. A leading
 * `_` is reserved for shared, non-entry modules in the same directory
 * (`_mount.tsx`, `_agent.tsx`), which vite.config.ts excludes from the inputs.
 */
export function entrySlugFor(path: string): string {
    // Cloudflare Pages serves /agents and /agents/ from the same file, so the
    // browser can hand us either. `/` itself keeps its slash and is named.
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (trimmed === '' || trimmed === '/') return 'home';
    return trimmed.replace(/^\//, '').replace(/\//g, '--');
}

/**
 * The Vite manifest KEY for a path's entry — a project-root-relative source
 * path, which is exactly how Vite keys a JS input in .vite/manifest.json.
 * scripts/prerender.mjs looks the emitted file up by this string.
 */
export function entryModuleFor(path: string): string {
    return `src/entries/${entrySlugFor(path)}.tsx`;
}
