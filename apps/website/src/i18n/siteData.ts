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
import * as navigation from '../data/navigation';
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
    navigation,
    pageProse,
    providers,
    security,
    terminalFeature,
    usageLimits,
} as const;

export type SiteData = typeof MODULES;

const cache = new Map<Locale, SiteData>();

const OVERRIDES = new Map<Locale, Readonly<Record<string, string>>>();

/**
 * Hand this module a locale's translations, keyed by the ids in
 * src/i18n/generated/en.json. A locale nobody registers resolves to English for
 * every id — correct behaviour, not an error.
 *
 * A REGISTRY, NOT AN `import.meta.glob`, AND THE DIFFERENCE WAS MEASURED.
 * `glob('./messages/overlays/*.json', { eager: true })` put all nine locales —
 * 1.4 MB of JSON — into the chunk every route shares. The first build after the
 * translations landed went from 153 KB gzip to 570 KB, 553 KB of it shared by
 * every page: every visitor downloading nine languages to read one, which is
 * precisely what the route split had just been done to stop.
 *
 * With a registry the caller that knows the locale supplies it. A client entry
 * statically imports its OWN overlay and nothing else; an English entry imports
 * none and carries none; the bundler splits them for free. The prerenderer
 * registers all of them through ./overlays.server.ts, which exists only in the
 * SSR bundle and is never shipped.
 */
export function registerOverlay(locale: Locale, overrides: Readonly<Record<string, string>>): void {
    OVERRIDES.set(locale, overrides);
    cache.delete(locale);
}

function overridesFor(locale: Locale): Readonly<Record<string, string>> {
    return OVERRIDES.get(locale) ?? {};
}

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
