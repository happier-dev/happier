import fs from 'node:fs';
import path from 'node:path';

/**
 * Emits dist/sitemap.xml, and refuses to finish the build if the sitemap and the
 * prerendered output disagree.
 *
 * WHY THIS IS GENERATED AND NOT A FILE IN public/
 * -----------------------------------------------
 * A hand-written public/sitemap.xml is copied to dist/ verbatim and is correct
 * exactly until the day someone adds a route. Then it is wrong, silently, and
 * nothing fails — you find out from Search Console weeks later, or never. The
 * failure mode is invisible, which is the worst kind.
 *
 * WHY THE ROUTE LIST IS NO LONGER IN THIS FILE
 * --------------------------------------------
 * It used to be. A `ROUTES` array lived here, in a build plugin, while the app
 * had its own idea of what pages existed — which is precisely the drift this
 * docblock warned about. src/routes.tsx is now the single source; the manifest
 * arrives as an argument.
 *
 * WHY THIS IS NO LONGER A VITE PLUGIN
 * -----------------------------------
 * It ran on the client build's `closeBundle`, which is BEFORE the prerenderer
 * writes any HTML. Its central assertion — "every route has a built page" —
 * could therefore only ever be checked against the single empty shell Vite
 * itself emitted, and would have started passing vacuously the moment a second
 * route existed. scripts/prerender.mjs calls `writeSitemap` after every file is
 * on disk, which is the only moment both assertions mean anything.
 *
 * The two things that actually go wrong, both build errors here:
 *
 *   1. A route is in the sitemap but was never prerendered → the sitemap
 *      advertises a URL that now 404s (public/404.html catches it correctly,
 *      which means Search Console reports "Submitted URL not found (404)").
 *   2. A page was prerendered but is missing from the route table → a real page
 *      that no crawler is told about.
 *
 * ADDING A ROUTE: add one entry to ROUTES in src/routes.tsx. The prerenderer
 * emits the file, this emits the sitemap line, and assert-crawlable checks the
 * result. Add a rule to public/_redirects ONLY if it needs one, and never add
 * `/* /index.html 200` — see the argument in _redirects.
 *
 * `lastmod` is intentionally the build date rather than a per-page git mtime:
 * a fabricated per-URL date is worse than an honest one, and Google largely
 * ignores lastmod it does not trust.
 */

const SITE = 'https://happier.dev';

function buildXml(routes, lastmod) {
    const urls = routes
        .map(
            (route) =>
                `    <url>\n` +
                `        <loc>${SITE}${route.path}</loc>\n` +
                `        <lastmod>${lastmod}</lastmod>\n` +
                `    </url>`,
        )
        .join('\n');

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        `${urls}\n` +
        '</urlset>\n'
    );
}

/**
 * @param {{ dist: string, routes: Array<{ path: string, file: string }> }} params
 * @returns {{ count: number }}
 */
export function writeSitemap({ dist, routes }) {
    if (!fs.existsSync(dist)) throw new Error(`sitemap: ${dist} does not exist.`);
    if (!Array.isArray(routes) || routes.length === 0) {
        throw new Error('sitemap: the route manifest is empty. Nothing would be indexable.');
    }

    for (const route of routes) {
        const file = path.join(dist, route.file);
        if (!fs.existsSync(file)) {
            throw new Error(
                `sitemap: route "${route.path}" has no built page at dist/${route.file}. ` +
                    'Either the prerenderer did not emit it, or the route should be removed from ' +
                    'ROUTES in src/routes.tsx. Shipping it would submit a URL that answers 404.',
            );
        }
    }

    // Catch the opposite drift: an HTML page in dist/ that no one told the
    // crawlers about. 404.html is excluded by design — it carries
    // <meta name="robots" content="noindex"> and must never appear in a sitemap.
    const built = fs
        .readdirSync(dist, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => path.relative(dist, path.join(entry.parentPath ?? entry.path, entry.name)))
        .filter((rel) => rel !== '404.html');

    const declared = new Set(routes.map((route) => route.file));
    const orphans = built.filter((rel) => !declared.has(rel));
    if (orphans.length > 0) {
        throw new Error(
            'sitemap: these pages were built but are not in ROUTES (src/routes.tsx), so nothing ' +
                `would link crawlers to them: ${orphans.join(', ')}`,
        );
    }

    const lastmod = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dist, 'sitemap.xml'), buildXml(routes, lastmod), 'utf8');
    return { count: routes.length };
}
