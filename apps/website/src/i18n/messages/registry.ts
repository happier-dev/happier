import { DEFAULT_LOCALE, type Locale } from '../locales';
import { en, type Messages } from './en';
import { zhHans } from './zh-Hans';

/**
 * Locale → message tree.
 *
 * Deliberately React-free and in its own module: the prerender script runs in
 * plain Node and needs `messagesFor` to build each locale's <head>, but must
 * not pull in React, framer-motion, or anything that touches `window`.
 *
 * Each value is typed as the FULL `Messages`, so adding a key to `en.ts` breaks
 * the build for every other locale until it is translated. There is no per-key
 * English fallback on purpose: on a landing page a missing string silently
 * rendering in English is worse than a red build, because nobody notices until
 * a Chinese visitor does.
 */
export const MESSAGES: Record<Locale, Messages> = {
    en,
    'zh-Hans': zhHans,
};

export function messagesFor(locale: Locale): Messages {
    return MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
}

export type { Messages } from './en';
