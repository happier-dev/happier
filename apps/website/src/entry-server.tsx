import { renderToString } from 'react-dom/server';
import { App } from './App';

export { routeManifest, type RouteManifestEntry } from './routes';

/**
 * Server entry used only at build time by scripts/prerender.mjs.
 *
 * It deliberately does NOT import ./styles/globals.css — the client build owns
 * the stylesheet and emits the hashed <link> into dist/index.html. Importing it
 * here would make the SSR bundle try to emit a second copy.
 *
 * `renderToString` (not `renderToStaticMarkup`) because the output is hydrated
 * by src/main.tsx; static markup strips the markers hydration matches against.
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
 */
export function render(path: string): string {
    return renderToString(<App path={path} />);
}
