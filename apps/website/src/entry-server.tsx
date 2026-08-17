import { renderToString } from 'react-dom/server';
import { App } from './App';
import { routeManifest as routeTable, type RouteManifestEntry } from './routes';
import { entryModuleFor } from './entries/_names';
import { registerAllOverlays } from './i18n/overlays.server';

// The build-time renderer walks every route in every locale in one process, so
// it is the one caller that genuinely needs all the overlays at once. That
// import lives HERE and nowhere else: pulled into a client entry it would put
// all nine languages back into every visitor's download. See the note on
// registerOverlay in ./i18n/siteData.ts.
registerAllOverlays();

export type { RouteManifestEntry } from './routes';

/**
 * Server entry used only at build time by scripts/prerender.mjs.
 *
 * It deliberately does NOT import ./styles/globals.css — the client build owns
 * the stylesheet and emits the hashed <link> into dist/index.html. Importing it
 * here would make the SSR bundle try to emit a second copy.
 *
 * `renderToString` (not `renderToStaticMarkup`) because the output is hydrated
 * by the per-route client entries in src/entries/; static markup strips the
 * markers hydration matches against.
 *
 * Nothing in the tree suspends or fetches during render — every network call in
 * this app lives in a useEffect (src/sections/Nav.tsx, src/components/
 * publicStats.ts) and effects do not run on the server — so the synchronous
 * renderer is sufficient. If a Suspense boundary is ever added, switch to
 * `prerender` from 'react-dom/static', which awaits the whole shell.
 *
 * `render` now takes a path. It throws on an unknown one (see src/App.tsx), so
 * a route that exists in the sitemap and nowhere else fails the BUILD rather
 * than shipping a URL that answers 404.
 *
 * THE SERVER STILL RENDERS THROUGH App, AND THE CLIENT NO LONGER DOES. That
 * asymmetry is the point of the route split: this bundle runs once, in Node, at
 * build time, and has to be able to render any path, so importing the whole
 * route table costs nothing. The browser already knows which page it is on —
 * Cloudflare Pages served it as its own file — so its entry names one page and
 * downloads one page's code. See src/entries/_mount.tsx for why the two trees
 * are identical anyway.
 */
export function render(path: string): string {
    return renderToString(<App path={path} />);
}

/** A route manifest entry, plus the client entry that hydrates that file. */
export type PrerenderRoute = RouteManifestEntry & {
    /**
     * Vite manifest key for this page's client entry — a project-root-relative
     * source path such as `src/entries/security.tsx`.
     *
     * scripts/prerender.mjs resolves it against dist/.vite/manifest.json to get
     * the hashed chunk, and fails the build naming this exact file when it is
     * missing. That failure is the only thing keeping ROUTES and src/entries/ in
     * step, so it must stay a hard error.
     */
    clientEntry: string;
};

/**
 * One entry per (route, locale) pair the build must emit, each carrying the
 * client entry its HTML has to load.
 *
 * Re-exported rather than passed straight through from ./routes so the entry
 * mapping is applied in ONE place: the prerenderer, the sitemap and the
 * crawlability gate all consume this list, and none of them should have to know
 * the naming rule. src/routes.tsx stays free of any knowledge of the bundler.
 */
export function routeManifest(): PrerenderRoute[] {
    return routeTable().map((route) => ({ ...route, clientEntry: entryModuleFor(route.path) }));
}
