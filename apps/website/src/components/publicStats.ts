import { useEffect, useState } from 'react';

/**
 * Shared plumbing for the small public counters on the marketing site
 * (downloads, Discord members).
 *
 * Every one of them has the same shape: a static fallback compiled into the
 * bundle so the number is never blank or zero, replaced at runtime by a JSON
 * document published to stats.happier.dev. A failed or malformed fetch keeps
 * the fallback rather than degrading the page.
 */

/**
 * Where published stats are read from.
 *
 * stats.happier.dev returns `Access-Control-Allow-Origin` only for
 * https://happier.dev and https://www.happier.dev, so a browser on localhost can
 * never read it directly — the request is blocked and every counter silently
 * sits on its compiled-in fallback, which makes the loaded state impossible to
 * see or test in dev. Development goes through the Vite proxy declared in
 * vite.config.ts so the request is same-origin; production hits the real host.
 */
export function statsUrl(file: string): string {
    return import.meta.env.DEV ? `/__stats/${file}` : `https://stats.happier.dev/${file}`;
}

/**
 * Grouped count formatting, shared so every public counter reads alike.
 *
 * `locales` defaults to the visitor's own, so a Swiss browser gets 35'020 and a
 * French one 35 020 rather than the US 35,020. <RollingNumber> already treats
 * every non-digit as a static glyph, so whichever separator the locale picks
 * simply sits between the rolling columns.
 *
 * These used to render compactly ("21.8K"). Compact notation changes the shape
 * of the string as the value moves — "21.8K" is five glyphs, "35K" is three —
 * so the digit columns would mount and unmount mid-roll instead of rolling.
 * Grouped figures keep a stable column count, and a real number reads better on
 * a marketing page than a rounded one anyway.
 *
 * Callers pass `locales` only to pin a value in tests; production omits it.
 */
export function formatStatCount(value: number, locales?: string | string[]): string {
    return value.toLocaleString(locales);
}

/**
 * Read a count off an unknown JSON payload, rejecting anything that is not a
 * finite, non-negative number. Published stats are third-party input to this
 * bundle, so they are validated rather than trusted.
 */
export function readCount(source: unknown, key: string): number | null {
    if (!source || typeof source !== 'object') return null;
    const raw = (source as Record<string, unknown>)[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
    return Math.floor(raw);
}

/**
 * Resolve a published stat, starting from `fallback` and upgrading in place if
 * the fetch succeeds and parses.
 */
export function usePublicStat<T>(url: string, parse: (raw: unknown) => T | null, fallback: T): T {
    const [stat, setStat] = useState(fallback);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const response = await fetch(url);
                if (!response.ok) return;
                const parsed = parse(await response.json());
                if (!cancelled && parsed) setStat(parsed);
            } catch {
                /* Keep the static fallback when public stats are unavailable. */
            }
        }

        load();

        return () => {
            cancelled = true;
        };
        // `parse` is a module-level function per caller; the URL is the real input.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url]);

    return stat;
}
