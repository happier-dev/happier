/**
 * Validate the authored per-locale route metadata and emit it as a module.
 *
 * Titles and descriptions are the one part of the site that cannot be
 * translated — the English sits at 143-155 characters against a 155 cap — so
 * they are written per locale by hand. This checks the things a writer cannot
 * check by eye across 210 pages, and refuses to emit anything if they fail:
 *
 *   caps        title <= 60, description 61..155. These are the same numbers
 *               src/routes.test.ts asserts; failing here gives a better message
 *               than failing there, and stops a bad locale reaching the build.
 *   uniqueness  ACROSS EVERY (route, locale) PAIR, not per locale. Two pages
 *               sharing a <title> compete for one query and both lose — which is
 *               exactly what happens by default, because an untranslated locale
 *               inherits the English title.
 *   coverage    every locale must cover every route, or the pages it misses
 *               would ship English metadata over translated content.
 *
 * Output is src/data/routeMetaI18n.ts, which src/routes.tsx reads through
 * `metaFor`. It is a data module, so nothing else has to change: it is keyed by
 * route path, and a route with no entry falls back to its English.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = join(ROOT, 'src/i18n/messages/overlays/.parts');
const OUT = join(ROOT, 'src/data/routeMetaI18n.ts');
const CHECK = process.argv.includes('--check');

const TITLE_MAX = 60;
const DESC_MAX = 155;
const DESC_MIN = 61;
const FIELDS = ['title', 'description', 'ogTitle', 'ogDescription', 'ogImageAlt'];

const english = JSON.parse(readFileSync(join(ROOT, 'src/i18n/generated/routeMeta.en.json'), 'utf8'));
const routePaths = Object.keys(english);

const files = existsSync(PARTS)
    ? readdirSync(PARTS).filter((f) => /^routeMeta\.[\w-]+\.json$/.test(f))
    : [];

if (!files.length) {
    console.error(`no routeMeta.<locale>.json files in ${PARTS}`);
    process.exit(1);
}

// Seed the uniqueness maps with English, so a locale that leaves a page
// untranslated collides with the English page it would compete against.
const titles = new Map();
const descriptions = new Map();
for (const [path, m] of Object.entries(english)) {
    titles.set(m.title, `en ${path}`);
    descriptions.set(m.description, `en ${path}`);
}

const byLocale = {};
const problems = [];

for (const file of files.sort()) {
    const locale = file.replace(/^routeMeta\./, '').replace(/\.json$/, '');
    let data;
    try {
        data = JSON.parse(readFileSync(join(PARTS, file), 'utf8'));
    } catch (error) {
        problems.push(`${locale}: invalid JSON — ${error.message}`);
        continue;
    }

    const missing = routePaths.filter((p) => !data[p]);
    if (missing.length) problems.push(`${locale}: missing ${missing.length} route(s): ${missing.slice(0, 4).join(', ')}`);

    for (const [path, meta] of Object.entries(data)) {
        if (!english[path]) { problems.push(`${locale}: unknown route ${path}`); continue; }
        for (const field of FIELDS) {
            if (typeof meta[field] !== 'string' || !meta[field].trim()) {
                problems.push(`${locale} ${path}: missing ${field}`);
            }
        }
        if (typeof meta.title === 'string') {
            if (meta.title.length > TITLE_MAX) {
                problems.push(`${locale} ${path}: title ${meta.title.length} > ${TITLE_MAX}`);
            }
            const clash = titles.get(meta.title);
            if (clash) problems.push(`${locale} ${path}: title duplicates ${clash}`);
            else titles.set(meta.title, `${locale} ${path}`);
        }
        if (typeof meta.description === 'string') {
            if (meta.description.length > DESC_MAX || meta.description.length < DESC_MIN) {
                problems.push(`${locale} ${path}: description ${meta.description.length}, want ${DESC_MIN}..${DESC_MAX}`);
            }
            const clash = descriptions.get(meta.description);
            if (clash) problems.push(`${locale} ${path}: description duplicates ${clash}`);
            else descriptions.set(meta.description, `${locale} ${path}`);
        }
    }
    byLocale[locale] = data;
}

const locales = Object.keys(byLocale).sort();
console.log('locale     routes   longest title   longest description');
for (const locale of locales) {
    const entries = Object.values(byLocale[locale]);
    const t = Math.max(...entries.map((m) => (m.title ?? '').length));
    const d = Math.max(...entries.map((m) => (m.description ?? '').length));
    console.log(`  ${locale.padEnd(8)} ${String(entries.length).padStart(4)}   ${String(t).padStart(11)}   ${String(d).padStart(17)}`);
}

if (problems.length) {
    console.error(`\n${problems.length} problem(s) — nothing written:`);
    for (const p of problems.slice(0, 25)) console.error(`  ${p}`);
    if (problems.length > 25) console.error(`  …and ${problems.length - 25} more`);
    process.exit(1);
}

if (CHECK) {
    console.log('\nOK — metadata is valid (nothing written, --check)');
    process.exit(0);
}

// Rebuild keyed by route so routes.tsx can look up one path at a time.
const byRoute = {};
for (const path of routePaths) {
    byRoute[path] = {};
    for (const locale of locales) byRoute[path][locale] = byLocale[locale][path];
}

const body = Object.entries(byRoute)
    .map(([path, perLocale]) => {
        const inner = Object.entries(perLocale)
            .map(([locale, m]) => {
                const fields = FIELDS.map((f) => `            ${f}: ${JSON.stringify(m[f])},`).join('\n');
                return `        ${JSON.stringify(locale)}: {\n${fields}\n        },`;
            })
            .join('\n');
        return `    ${JSON.stringify(path)}: {\n${inner}\n    },`;
    })
    .join('\n');

writeFileSync(
    OUT,
    `import type { Locale } from '../i18n/locales';

/**
 * Per-locale search-result metadata, AUTHORED rather than translated.
 *
 * GENERATED by scripts/i18n-apply-route-meta.mjs from the per-locale files in
 * src/i18n/messages/overlays/.parts/. Edit those and re-run; edits here are
 * overwritten.
 *
 * These are not in the string catalogue on purpose. The English titles run
 * 36-58 characters against a 60 cap and the descriptions 143-155 against 155,
 * so a translation of either overflows before it starts — measured, 0 of 8
 * English descriptions survive a 25% expansion. Every locale's is written to
 * fit its own language while keeping the same promise and the same keywords.
 *
 * Uniqueness is enforced across every (route, locale) pair rather than within a
 * locale: two pages sharing a title compete for one query and both lose, and an
 * untranslated locale inheriting the English title is exactly that collision.
 */
export type RouteMetaFields = {
    title: string;
    description: string;
    ogTitle: string;
    ogDescription: string;
    ogImageAlt: string;
};

export const ROUTE_META_I18N: Record<string, Partial<Record<Locale, RouteMetaFields>>> = {
${body}
};
`,
    'utf8',
);

console.log(
    `\nOK — wrote src/data/routeMetaI18n.ts (${routePaths.length} routes x ${locales.length} locale(s))`,
);
