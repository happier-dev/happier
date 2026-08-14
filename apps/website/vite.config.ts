import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
              manifest: true,
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
