/**
 * Dump the English route metadata as JSON, for per-locale AUTHORING.
 *
 * Route titles and descriptions are the one part of this site that cannot be
 * translated. The English is written at 143-155 characters against a 155
 * ceiling and 47-58 against a 60 ceiling, so a Spanish or Russian rendering
 * overflows before it starts — measured: 0 of 8 descriptions survive a 25%
 * expansion. They have to be re-authored to fit, which is a writing job, not a
 * translation job, and it is why they live in `Route.i18n` rather than in the
 * string catalogue.
 *
 * Bundles and imports rather than parsing, for the same reason the string
 * extractor does: several titles are built from `AGENTS.length` and friends, and
 * a static read would capture the template instead of the sentence.
 */
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/i18n/generated/routeMeta.en.json');

const scratch = join(ROOT, 'node_modules/.cache');
mkdirSync(scratch, { recursive: true });
const tmp = mkdtempSync(join(scratch, 'routemeta-'));

try {
    const bundled = join(tmp, 'routes.mjs');
    await build({
        entryPoints: [join(ROOT, 'src/routes.tsx')],
        outfile: bundled,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        jsx: 'automatic',
        packages: 'external',
        // routes.tsx reaches the analytics module, which reads
        // `import.meta.env.VITE_POSTHOG_KEY`. That is a Vite substitution and
        // plain Node has no `import.meta.env` at all, so the import throws
        // before a single route is read. Nothing here needs the value.
        define: { 'import.meta.env': '{}' },
        logLevel: 'silent',
    });

    const { ROUTES } = await import(pathToFileURL(bundled).href);
    const meta = {};
    for (const route of ROUTES) {
        meta[route.path] = {
            title: route.title,
            description: route.description,
            ogTitle: route.ogTitle,
            ogDescription: route.ogDescription,
            ogImageAlt: route.ogImageAlt,
        };
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    console.log(`${Object.keys(meta).length} routes -> src/i18n/generated/routeMeta.en.json\n`);
    console.log('route                                title  desc');
    for (const [path, m] of Object.entries(meta)) {
        console.log(
            `  ${path.padEnd(34)} ${String(m.title.length).padStart(4)}  ${String(m.description.length).padStart(4)}`,
        );
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
