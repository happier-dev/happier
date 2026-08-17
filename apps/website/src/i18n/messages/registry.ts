import { DEFAULT_LOCALE, type Locale } from '../locales';
import { en, type Messages } from './en';
import { fr } from './fr';
import { zhHans } from './zh-Hans';

/**
 * Locale → message tree, with a PER-KEY ENGLISH FALLBACK.
 *
 * Deliberately React-free and in its own module: the prerender script runs in
 * plain Node and needs `messagesFor` to build each locale's <head>, but must
 * not pull in React, framer-motion, or anything that touches `window`.
 *
 * THIS FILE USED TO SAY THE OPPOSITE, and the reversal is deliberate. The old
 * rule was that every locale must be a complete `Messages`, so adding a key to
 * `en.ts` broke the build until it was translated — on the argument that a
 * string silently rendering in English is worse than a red build. That rule is
 * a large part of why the locale lane was never mounted: it made "every string
 * in every language" the only shippable state, and reaching it always cost more
 * than not starting.
 *
 * The trade now runs the other way. A non-default locale is a
 * `DeepPartial<Messages>`, anything missing resolves to English, and a
 * partially translated catalogue renders instead of failing to build. What
 * keeps a page from going out half-English is not the type system but
 * `Route.locales`: a route only gets a localised URL, an hreflang entry and a
 * sitemap row once it is declared ready. The fallback is the safety net for the
 * last few strings inside a page that has been declared — not the mechanism by
 * which pages ship unfinished.
 *
 * Coverage is therefore reported rather than enforced: `coverageFor` backs
 * `yarn i18n:status`.
 */

type DeepPartial<T> = T extends string
    ? T
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<DeepPartial<U>>
      : { [K in keyof T]?: DeepPartial<T[K]> };

/**
 * English is complete by construction; every other locale is optional and
 * partial. A locale with no entry here is not an error — it renders English for
 * the whole `Messages` tree and can still be fully translated at the data-module
 * level, because those are two independent catalogues.
 */
export const MESSAGES: { en: Messages } & Partial<Record<Exclude<Locale, 'en'>, DeepPartial<Messages>>> = {
    en,
    fr,
    'zh-Hans': zhHans,
};

/**
 * Fill `override` from `base`, key by key, arrays element by element.
 *
 * Element-wise on arrays matters: `lead` is three paragraphs, and a translator
 * who has finished two should ship two translated paragraphs and one English
 * one — not three English ones because the array lengths differ.
 */
function fillFrom<T>(base: T, override: unknown): T {
    if (override === undefined || override === null) return base;

    if (Array.isArray(base)) {
        if (!Array.isArray(override)) return base;
        return base.map((item, index) => fillFrom(item, override[index])) as unknown as T;
    }

    if (typeof base === 'object') {
        if (typeof override !== 'object' || Array.isArray(override)) return base;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
            out[key] = fillFrom(value, (override as Record<string, unknown>)[key]);
        }
        return out as T;
    }

    // Leaf. An empty string means "not translated yet", not "translated to
    // nothing" — a scaffolded catalogue is all empty strings and must render as
    // English rather than as blanks.
    if (typeof override === 'string' && override.trim() === '') return base;
    return override as T;
}

const resolvedCache = new Map<Locale, Messages>();

export function messagesFor(locale: Locale): Messages {
    if (locale === DEFAULT_LOCALE) return en;
    const hit = resolvedCache.get(locale);
    if (hit) return hit;
    const merged = fillFrom(en, MESSAGES[locale as Exclude<Locale, 'en'>]);
    resolvedCache.set(locale, merged);
    return merged;
}

/** How many of English's leaf strings a locale actually overrides. */
export function coverageFor(locale: Locale): { translated: number; total: number } {
    let translated = 0;
    let total = 0;
    const walk = (base: unknown, override: unknown): void => {
        if (typeof base === 'string') {
            total += 1;
            if (typeof override === 'string' && override.trim() !== '') translated += 1;
            return;
        }
        if (Array.isArray(base)) {
            base.forEach((item, i) => walk(item, Array.isArray(override) ? override[i] : undefined));
            return;
        }
        if (typeof base === 'object' && base !== null) {
            for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
                const next =
                    typeof override === 'object' && override !== null && !Array.isArray(override)
                        ? (override as Record<string, unknown>)[key]
                        : undefined;
                walk(value, next);
            }
        }
    };
    walk(en, locale === DEFAULT_LOCALE ? en : MESSAGES[locale as Exclude<Locale, 'en'>]);
    return { translated, total };
}

export type { Messages } from './en';
