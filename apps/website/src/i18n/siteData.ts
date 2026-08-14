/**
 * The data modules, in the reader's language.
 *
 * WHY THIS EXISTS. `src/data/*.ts` is authored in English and stays that way —
 * the evidence docblocks stay attached to the sentences they justify, and the
 * accuracy suites keep importing the modules directly and keep asserting on
 * English literals. Translation is an OVERLAY applied on the way to the page,
 * not a rewrite of the source.
 *
 * The ids come from `walkStrings` in ./overlay.ts, which is the same traversal
 * scripts/i18n-extract.mjs uses to produce the catalogue. Extraction and
 * substitution cannot drift, because they are the same function.
 *
 * `en` RETURNS THE MODULES BY IDENTITY. No clone, no allocation, no behaviour
 * change — which is what makes the whole locale lane verifiable by diffing
 * dist/ while every route is still English-only.
 */
import { DEFAULT_LOCALE, type Locale } from './locales';
import { applyOverlay } from './overlay';
import { useI18n } from './index';

import * as agents from '../data/agents';
import * as availability from '../data/availability';
import * as codexRemote from '../data/codexRemote';
import * as community from '../data/community';
import * as comparison from '../data/comparison';
import * as downloads from '../data/downloads';
import * as enterprise from '../data/enterprise';
import * as faq from '../data/faq';
import * as features from '../data/features';
import * as pageProse from '../data/pageProse';
import * as providers from '../data/providers';
import * as security from '../data/security';
import * as terminalFeature from '../data/terminalFeature';
import * as usageLimits from '../data/usageLimits';

/**
 * Namespace → module. The KEY IS THE ID PREFIX, and it must match the namespace
 * scripts/i18n-extract.mjs derives from the filename, or every id in that
 * module misses and the strings silently stay English.
 *
 * There is a test for exactly that (siteData.test.ts): it re-runs the
 * extractor's traversal over this registry and asserts every id it produces is
 * reachable here.
 */
const MODULES = {
    agents,
    availability,
    codexRemote,
    community,
    comparison,
    downloads,
    enterprise,
    faq,
    features,
    pageProse,
    providers,
    security,
    terminalFeature,
    usageLimits,
} as const;

export type SiteData = typeof MODULES;

/**
 * Per-locale string overrides, keyed by the ids in
 * src/i18n/generated/en.json. Locales with no file yet resolve to English for
 * every id, which is the correct behaviour and not an error.
 *
 * `import.meta.glob` with `eager` so the prerenderer — which runs the SSR
 * bundle in plain Node — gets them synchronously, and so Rollup can tree-shake
 * a locale nobody builds.
 */
const OVERLAYS = import.meta.glob<{ default: Record<string, string> }>('./messages/overlays/*.json', {
    eager: true,
});

function overridesFor(locale: Locale): Record<string, string> {
    return OVERLAYS[`./messages/overlays/${locale}.json`]?.default ?? {};
}

const cache = new Map<Locale, SiteData>();

export function siteDataFor(locale: Locale): SiteData {
    if (locale === DEFAULT_LOCALE) return MODULES;

    const hit = cache.get(locale);
    if (hit) return hit;

    const overrides = overridesFor(locale);
    const next = {} as Record<string, unknown>;
    for (const [ns, mod] of Object.entries(MODULES)) {
        const out: Record<string, unknown> = {};
        for (const [exportName, value] of Object.entries(mod as Record<string, unknown>)) {
            out[exportName] =
                typeof value === 'function' ? value : applyOverlay(value, overrides, `${ns}.${exportName}`);
        }
        next[ns] = out;
    }
    const built = next as SiteData;
    cache.set(locale, built);
    return built;
}

/** `const { agents } = useSiteData()` then `agents.AGENTS`. */
export function useSiteData(): SiteData {
    return siteDataFor(useI18n().locale);
}
