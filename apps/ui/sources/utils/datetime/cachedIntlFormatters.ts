import { LruMap } from '@/utils/cache/lruMap';

const dateTimeFormatterCache = new LruMap<string, Intl.DateTimeFormat>({ maxEntries: 64 });

function normalizeLocales(locales: Intl.LocalesArgument): string {
    if (Array.isArray(locales)) return locales.join('\u0001');
    return typeof locales === 'string' ? locales : '';
}

function buildDateTimeFormatterCacheKey(
    locales: Intl.LocalesArgument,
    options: Intl.DateTimeFormatOptions | undefined,
): string {
    const entries = Object.entries(options ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    return `${normalizeLocales(locales)}\u0000${JSON.stringify(entries)}`;
}

export function getCachedDateTimeFormatter(
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
    const key = buildDateTimeFormatterCacheKey(locales, options);
    const cached = dateTimeFormatterCache.get(key);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat(locales, options);
    dateTimeFormatterCache.set(key, formatter);
    return formatter;
}

export function formatWithCachedDateTimeFormatter(
    date: Date | number,
    locales?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
): string {
    return getCachedDateTimeFormatter(locales, options).format(date);
}
