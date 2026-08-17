import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

/**
 * One config, two builds.
 *
 *   vite build                                → dist/      (client bundle + shell HTML)
 *   vite build --ssr src/entry-server.tsx     → dist/.ssr/  (build-time renderer)
 *
 * scripts/prerender.mjs then runs the SSR bundle and pastes the markup into
 * dist/index.html, so the deployed page carries its own text instead of an
 * empty <div id="root">. See package.json "build".
 */
/**
 * Refuse to produce a production bundle with no analytics key.
 *
 * The mobile app's PostHog wiring degrades silently when its env var is absent
 * (apps/ui/sources/track/tracking.ts:40 — `tracking` just becomes `null`), which
 * is how a project can go a year without a single $pageview and nobody notice.
 * On the web the cost of that mistake is a deploy nobody can measure, so it is a
 * build failure instead. `vite dev` and `vite preview` are unaffected: a missing
 * key locally means "no analytics in dev", which is correct.
 */
function assertAnalyticsKey(mode: string) {
    return {
        name: 'happier:assert-analytics-key',
        apply: 'build' as const,
        config() {
            if (mode !== 'production') return;
            // Defined-but-empty is an explicit, deliberate "build without
            // analytics" (forks, air-gapped mirrors). Undefined is a mistake.
            if (process.env.VITE_POSTHOG_KEY !== undefined) return;
            throw new Error(
                'VITE_POSTHOG_KEY is not set. happier.dev has never recorded a $pageview; ' +
                    'shipping another unmeasured build is not an accident worth repeating. ' +
                    'Set it in the Cloudflare Pages project environment (Production and Preview), ' +
                    'or export VITE_POSTHOG_KEY="" to build an intentionally blind bundle.',
            );
        },
    };
}

/**
 * ONE ROLLUP INPUT PER PRERENDERED PAGE, DISCOVERED FROM DISK.
 *
 * The site used to ship a single bundle holding all 21 pages — 499 KB raw / 153
 * KB gzip, 27% of it site copy — because index.html loaded one entry
 * (src/main.tsx) that reached src/routes.tsx, and the route table imports every
 * page component there is. React needs that same data to hydrate, so a reader of
 * /security downloaded the copy for twenty pages they will never open.
 *
 * Each file in src/entries/ is now its own entry, naming exactly one page. This
 * function does NOT know the route table, the locale list, or how many pages
 * there are: it reads the directory. src/entry-server.tsx computes which entry
 * each (route, locale) pair needs, and scripts/prerender.mjs fails the build
 * naming the missing file if the two disagree — so a new route or a new locale
 * cannot silently ship an un-hydrated page, and nothing here has to be counted.
 *
 * Files beginning with `_` are the shared halves (_mount.tsx, _agent.tsx) rather
 * than pages, so they are skipped as inputs; Rollup still emits them, once, as
 * chunks the entries that need them share.
 */
const ENTRY_DIR = path.resolve(__dirname, 'src/entries');

function routeEntryInputs(): Record<string, string> {
    const files = readdirSync(ENTRY_DIR).filter((f) => f.endsWith('.tsx') && !f.startsWith('_'));
    if (files.length === 0) {
        throw new Error(
            `src/entries/ contains no page entries. Every route in ROUTES (src/routes.tsx) ` +
                'needs one — see src/entries/_names.ts for the naming rule.',
        );
    }
    // `route-` prefixed so an entry can never collide with the `index` HTML
    // input, and so the emitted chunk is legible in dist/ and in the perf
    // report: assets/route-security-<hash>.js.
    return Object.fromEntries(
        files.map((f) => [`route-${f.slice(0, -'.tsx'.length)}`, path.join(ENTRY_DIR, f)]),
    );
}

export default defineConfig(({ isSsrBuild, mode }) => ({
    // The sitemap is NOT a plugin any more. As a closeBundle hook it ran before
    // scripts/prerender.mjs had written a single route file, so its "every route
    // has a built page" assertion could only ever check the empty shell Vite
    // itself emitted. It now runs from the prerenderer, after every file exists
    // — see scripts/sitemap.mjs.
    plugins: [react(), assertAnalyticsKey(mode)],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    css: {
        postcss: {
            plugins: [tailwindcss, autoprefixer],
        },
    },
    build: isSsrBuild
        ? {
              // A subdirectory keeps the client and renderer under one artifact
              // owner without letting the SSR invocation clear the client build.
              // prerender.mjs removes it before deployment.
              outDir: 'dist/.ssr',
              emptyOutDir: false,
              copyPublicDir: false,
              ssr: true,
              // Node ESM output; prerender.mjs imports it with a dynamic import().
              rollupOptions: {
                  output: { format: 'es', entryFileNames: 'entry-server.js' },
              },
          }
          : {
              outDir: 'dist',
              emptyOutDir: true,
              // Gives the performance gate the exact static entry graph so
              // lazily loaded analytics code is not misclassified as first paint.
              // With one entry per route it is also how scripts/prerender.mjs
              // finds the hashed chunk each page must load, so it is now
              // load-bearing for correctness and not only for measurement.
              manifest: true,
              /**
               * ONE STYLESHEET FOR THE WHOLE SITE, ON PURPOSE.
               *
               * Vite injects <link rel="stylesheet"> into HTML inputs, and there
               * is exactly one HTML input — the shell — which prerender.mjs
               * copies to every page. Per-entry CSS would therefore be emitted
               * as files no page ever links: every route would carry the shell's
               * link and nothing else. There is no per-route CSS to win anyway
               * (one Tailwind build, 7.5 KB gzip), so the split is all risk and
               * no prize. scripts/prerender.mjs asserts the shell really did get
               * a stylesheet link, so this assumption cannot fail quietly.
               */
              cssCodeSplit: false,
              rollupOptions: {
                  input: {
                      // The shell. Still the only HTML input: it is what Vite
                      // injects the stylesheet and the icons into, and what
                      // prerender.mjs uses as the template for every page.
                      index: path.resolve(__dirname, 'index.html'),
                      ...routeEntryInputs(),
                  },
                  output: {
                      /**
                       * REACT IS EMITTED ONCE, NOT ONCE PER ROUTE.
                       *
                       * This is the failure mode that would make splitting worse
                       * than not splitting: 21 entries each carrying their own
                       * copy of react-dom (~140 KB raw) is a site that got
                       * slower for everyone. Rollup's automatic chunking would
                       * usually hoist a module shared by every entry, but
                       * "usually" is not a guarantee anyone should ship a
                       * homepage on, so react/react-dom/scheduler/jsx-runtime
                       * are pinned to one named chunk and
                       * scripts/assert-perf-budget.mjs fails the build unless
                       * dist/ holds exactly one vendor-react file AND every
                       * route entry statically imports it.
                       *
                       * Deliberately react only. posthog-js is loaded with a
                       * dynamic `import()` (src/analytics/analytics.ts:199) so
                       * it stays off the critical path; naming it here would
                       * drag 40 KB of analytics into the first paint of every
                       * page.
                       */
                      manualChunks(id: string) {
                          if (/node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) {
                              return 'vendor-react';
                          }
                          return undefined;
                      },
                  },
              },
          },
    server: {
        port: 5173,
        host: true,
        allowedHosts: ['localhost', '127.0.0.1', '100.79.179.31', 'leeroy-mbp'],
        // stats.happier.dev allowlists only the production origins for CORS, so a
        // direct fetch from localhost is always blocked and the counters can only
        // ever show their fallbacks in dev. Proxying makes it same-origin.
        // See statsUrl() in src/components/publicStats.ts.
        proxy: {
            '/__stats': {
                target: 'https://stats.happier.dev',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/__stats/, ''),
            },
            // Mirrors functions/ingest/[[path]].ts so `vite dev` exercises the
            // same first-party ingest path production uses. Without it every
            // dev event 404s and the wiring is only ever tested in production.
            '/ingest/static': {
                target: 'https://eu-assets.i.posthog.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/ingest/, ''),
            },
            '/ingest': {
                target: 'https://eu.i.posthog.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/ingest/, ''),
            },
        },
    },
}));
