/**
 * Write one client entry per (route, locale) pair.
 *
 * vite.config.ts turns every non-underscore file in src/entries/ into a Rollup
 * input, and scripts/prerender.mjs fails the build naming the file to create if
 * a route in the manifest has no entry. With ten locales that is 210 files, so
 * the nine non-English ones are generated FROM the English entry rather than
 * written by hand — the English file already names the right page component and
 * the right shared helper, and copying it is the only way those two facts can't
 * drift.
 *
 * WHY EACH ENTRY IMPORTS ITS OWN OVERLAY. src/i18n/siteData.ts takes
 * translations through `registerOverlay` instead of discovering them with a
 * glob, because the glob put all nine locales — 1.4 MB — into the chunk every
 * route shares and took the worst route from 153 KB gzip to 570 KB. A generated
 * entry statically imports exactly one overlay JSON, so Rollup gives that locale
 * its own chunk and an English visitor downloads none of it.
 *
 * Usage:
 *   node scripts/i18n-generate-entries.mjs --dry
 *   node scripts/i18n-generate-entries.mjs --write
 *   node scripts/i18n-generate-entries.mjs --prune   # delete orphans too
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = join(ROOT, 'src/entries');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write') || argv.includes('--prune');
const PRUNE = argv.includes('--prune');

/**
 * Locale metadata, read out of the TypeScript source rather than imported.
 *
 * src/i18n/locales.ts is a .ts module and this is a plain Node script; bundling
 * it just to read two fields per locale would be heavier than the parse. The
 * shapes matched here are exactly what that file declares, and a change to them
 * fails loudly below rather than silently generating nothing.
 */
function readLocales() {
    const source = readFileSync(join(ROOT, 'src/i18n/locales.ts'), 'utf8');
    const listMatch = source.match(/export const LOCALES = \[([\s\S]*?)\] as const;/);
    if (!listMatch) throw new Error('could not find LOCALES in src/i18n/locales.ts');
    const codes = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    const prefixes = new Map();
    for (const code of codes) {
        const block = new RegExp(
            `['"]?${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:\\s*\\{[\\s\\S]*?pathPrefix:\\s*'([^']*)'`,
        ).exec(source);
        if (!block) throw new Error(`no pathPrefix for locale ${code} in src/i18n/locales.ts`);
        prefixes.set(code, block[1]);
    }
    return { codes, prefixes };
}

/** src/entries/_names.ts entrySlugFor, reproduced for a plain-Node caller. */
function entrySlugFor(path) {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (trimmed === '' || trimmed === '/') return 'home';
    return trimmed.replace(/^\//, '').replace(/\//g, '--');
}

const { codes, prefixes } = readLocales();
const DEFAULT_LOCALE = codes[0] === 'en' ? 'en' : codes[0];
const others = codes.filter((c) => c !== DEFAULT_LOCALE);

/** The English entries are the source of truth for which pages exist. */
const englishEntries = readdirSync(ENTRIES)
    .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
    .filter((f) => !others.some((code) => f.startsWith(`${prefixes.get(code).replace(/^\//, '')}--`) || f === `${prefixes.get(code).replace(/^\//, '')}.tsx`))
    .map((f) => basename(f, '.tsx'));

/** `home` → `/`, `agents--claude-code` → `/agents/claude-code`. */
function pathForSlug(slug) {
    return slug === 'home' ? '/' : `/${slug.replace(/--/g, '/')}`;
}

const generated = [];
const wanted = new Set(englishEntries.map((s) => `${s}.tsx`));

for (const code of others) {
    const prefix = prefixes.get(code);
    if (!prefix) continue;
    const overlay = join(ROOT, `src/i18n/messages/overlays/${code}.json`);
    if (!existsSync(overlay)) {
        console.log(`  skipping ${code}: no overlay at src/i18n/messages/overlays/${code}.json`);
        continue;
    }

    /*
     * Which translation namespaces each route reads, measured by
     * scripts/i18n-slice-overlays.mjs by rendering it. An entry imports exactly
     * those files, so 14 agent pages share one agents.json chunk instead of
     * carrying 14 copies, and a page that reads none of it downloads none of it.
     */
    const manifestPath = join(ROOT, `src/i18n/generated/slices/${code}/_routes.json`);
    if (!existsSync(manifestPath)) {
        console.error(
            `  ${code}: no slice manifest at src/i18n/generated/slices/${code}/_routes.json — ` +
                'run `yarn build:server && yarn i18n:slice` first.',
        );
        continue;
    }
    const sliceManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    for (const slug of englishEntries) {
        const routePath = pathForSlug(slug);
        const servedPath = routePath === '/' ? prefix : `${prefix}${routePath}`;
        const targetSlug = entrySlugFor(servedPath);
        const targetFile = join(ENTRIES, `${targetSlug}.tsx`);
        wanted.add(`${targetSlug}.tsx`);

        const source = readFileSync(join(ENTRIES, `${slug}.tsx`), 'utf8');

        // Swap the locale literal in the mount call, and nothing else — the page
        // import and the shared helper are already correct by construction.
        let body = source.replace(/\b(mount|mountAgentPage)\('en'/g, `$1('${code}'`);
        if (body === source) {
            console.error(`  ${slug}.tsx: no mount('en'…) call to localise — skipped`);
            continue;
        }

        const namespaces = sliceManifest[slug];
        if (!Array.isArray(namespaces)) {
            console.error(`  ${slug}.tsx: no slice entry for ${code} — re-run yarn i18n:slice`);
            continue;
        }
        const nsIdent = (ns) => `ns_${ns.replace(/[^A-Za-z0-9]/g, '_')}`;
        const nsImports = namespaces
            .map((ns) => `import ${nsIdent(ns)} from '../i18n/generated/slices/${code}/${ns}.json';`)
            .join('\n');
        const nsMerge = namespaces.map(nsIdent).join(', ');

        body = body.replace(
            /^(import .*\n)(?![\s\S]*^import )/m,
            `$1import { registerOverlay } from '../i18n/siteData';\n${nsImports}\n`,
        );
        body = body.replace(
            /\n(\/\*\*[\s\S]*?\*\/\n)?((?:mount|mountAgentPage)\(')/,
            `\n\n// Registered here, not discovered by a glob: this entry is the only place\n// that knows the page is ${code}, which keeps the other nine locales out of\n// its download. The imports above are the translation NAMESPACES this route\n// was measured to read — scripts/i18n-slice-overlays.mjs renders the page to\n// find them and proves the set reproduces its HTML byte for byte. Rollup\n// shares each namespace chunk between the routes that import it.\nregisterOverlay('${code}', Object.assign({}, ${nsMerge}));\n\n$1$2`,
        );

        const header = `// GENERATED by scripts/i18n-generate-entries.mjs from ${slug}.tsx — do not edit.\n`;
        const out = header + body;

        generated.push({ file: targetFile, slug: targetSlug, changed: !existsSync(targetFile) || readFileSync(targetFile, 'utf8') !== out });
        if (WRITE) writeFileSync(targetFile, out, 'utf8');
    }
}

const orphans = readdirSync(ENTRIES)
    .filter((f) => f.endsWith('.tsx') && !f.startsWith('_') && !f.includes('.test.'))
    .filter((f) => !wanted.has(f));

const changed = generated.filter((g) => g.changed).length;
console.log(
    `${WRITE ? 'wrote' : 'would write'} ${generated.length} entr${generated.length === 1 ? 'y' : 'ies'} ` +
        `for ${others.length} locale(s) x ${englishEntries.length} route(s); ${changed} new or changed`,
);
if (orphans.length) {
    console.log(`\n${PRUNE ? 'deleting' : 'ORPHANS (no route wants these; --prune to delete)'}: ${orphans.length}`);
    for (const f of orphans) {
        console.log(`  ${f}`);
        if (PRUNE) unlinkSync(join(ENTRIES, f));
    }
}
