import type { BundledLanguage, BundledTheme, HighlighterGeneric, TokensResult } from 'shiki';
import { createHighlighter } from 'shiki';

import { resolveShikiLanguageId } from '@/components/ui/code/highlighting/resolveShikiLanguageId';
import {
    clearHappierTextMateThemeRegistrationCacheForKey,
    getHappierTextMateThemeRegistration,
    resolveHappierTextMateThemeId,
} from '@/components/ui/code/highlighting/shiki/happierTextMateTheme';
import { LruMap } from '@/utils/cache/lruMap';

export type ShikiInlineToken = Readonly<{ text: string; color: string }>;

type ShikiToken = Readonly<{ content: string; color?: string }>;
type ShikiCodeToTokensResult = Readonly<{ tokens: readonly (readonly ShikiToken[])[]; fg?: string }>;
type ShikiHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

type CachedHighlighter = Readonly<{
    highlighter: ShikiHighlighter;
    loadedLanguageIds: ReadonlySet<string>;
}>;

const highlighterCache = new Map<string, { highlighter: ShikiHighlighter; loadedLanguageIds: Set<string> }>();
const highlighterInflight = new Map<string, Promise<CachedHighlighter>>();
const highlighterCacheGeneration = new Map<string, number>();
const SHIKI_HIGHLIGHTER_CACHE_CAP = 8;
const shikiTokenizationCache = new LruMap<string, Readonly<{ tokensByLine: readonly (readonly ShikiInlineToken[])[]; fg: string }>>({ maxEntries: 32 });

export function resolveHappierShikiThemeId(params: Readonly<{ isDark: boolean; colors?: Record<string, unknown> | null }>): string {
    return resolveHappierTextMateThemeId(params);
}

function buildShikiHighlighterCacheKey(params: Readonly<{ themeId: string; languageId: string }>): string {
    return `${params.themeId}::${params.languageId}`;
}

function buildShikiTokenizationCacheKey(params: Readonly<{
    code: string;
    languageId: string;
    themeId: string;
}>): string {
    return [params.themeId, params.languageId, params.code].join('\u0000');
}

function disposeHighlighter(highlighter: ShikiHighlighter): void {
    const dispose = (highlighter as { dispose?: unknown }).dispose;
    if (typeof dispose === 'function') dispose.call(highlighter);
}

function touchHighlighterCacheEntry(key: string): { highlighter: ShikiHighlighter; loadedLanguageIds: Set<string> } | null {
    const cached = highlighterCache.get(key);
    if (!cached) return null;
    highlighterCache.delete(key);
    highlighterCache.set(key, cached);
    return cached;
}

function setHighlighterCacheEntry(key: string, entry: { highlighter: ShikiHighlighter; loadedLanguageIds: Set<string> }): void {
    if (highlighterCache.has(key)) highlighterCache.delete(key);
    highlighterCache.set(key, entry);
    while (highlighterCache.size > SHIKI_HIGHLIGHTER_CACHE_CAP) {
        const oldest = highlighterCache.keys().next().value as string | undefined;
        if (!oldest) break;
        const evicted = highlighterCache.get(oldest);
        highlighterCache.delete(oldest);
        if (evicted) disposeHighlighter(evicted.highlighter);
    }
}

function getHighlighterCacheGeneration(key: string): number {
    return highlighterCacheGeneration.get(key) ?? 0;
}

function bumpHighlighterCacheGeneration(key: string): void {
    highlighterCacheGeneration.set(key, getHighlighterCacheGeneration(key) + 1);
}

export function clearShikiCacheForKey(oldKey: string): void {
    const affectedKeys = new Set<string>();
    for (const key of Array.from(highlighterCache.keys())) {
        if (!key.startsWith(`${oldKey}::`)) continue;
        affectedKeys.add(key);
        const entry = highlighterCache.get(key);
        highlighterCache.delete(key);
        if (entry) disposeHighlighter(entry.highlighter);
    }
    for (const key of Array.from(highlighterInflight.keys())) {
        if (!key.startsWith(`${oldKey}::`)) continue;
        affectedKeys.add(key);
        highlighterInflight.delete(key);
    }
    for (const key of affectedKeys) {
        bumpHighlighterCacheGeneration(key);
    }
    shikiTokenizationCache.clear();
    clearHappierTextMateThemeRegistrationCacheForKey(oldKey);
}

async function getShikiHighlighterForTheme(params: Readonly<{ themeId: string; isDark: boolean; colors?: Record<string, unknown> | null; languageId: string }>): Promise<CachedHighlighter> {
    const cacheKey = buildShikiHighlighterCacheKey({ themeId: params.themeId, languageId: params.languageId });
    const cached = touchHighlighterCacheEntry(cacheKey);
    if (cached) return { highlighter: cached.highlighter, loadedLanguageIds: cached.loadedLanguageIds };

    const inflight = highlighterInflight.get(cacheKey);
    if (inflight) return await inflight;

    const cacheGeneration = getHighlighterCacheGeneration(cacheKey);
    const promise: Promise<CachedHighlighter> = (async () => {
        const theme = getHappierTextMateThemeRegistration({ isDark: params.isDark, colors: params.colors });
        const langs = Array.from(new Set(['text', params.languageId])) as unknown as BundledLanguage[];
        const highlighter = await createHighlighter({
            themes: [theme as any],
            langs,
        });

        const entry = { highlighter: highlighter as any, loadedLanguageIds: new Set<string>(langs as unknown as string[]) };
        if (getHighlighterCacheGeneration(cacheKey) === cacheGeneration) {
            setHighlighterCacheEntry(cacheKey, entry);
        }
        return { highlighter: entry.highlighter, loadedLanguageIds: entry.loadedLanguageIds };
    })().finally(() => {
        // Always clear inflight to allow retries after failures.
        if (highlighterInflight.get(cacheKey) === promise) {
            highlighterInflight.delete(cacheKey);
        }
    });

    highlighterInflight.set(cacheKey, promise);
    return await promise;
}

async function ensureLanguageLoaded(params: Readonly<{ highlighter: ShikiHighlighter; loadedLanguageIds: Set<string>; languageId: string }>): Promise<void> {
    if (params.loadedLanguageIds.has(params.languageId)) return;
    const maybeLoad = (params.highlighter as any).loadLanguage;
    if (typeof maybeLoad === 'function') {
        await maybeLoad.call(params.highlighter, params.languageId);
    }
    params.loadedLanguageIds.add(params.languageId);
}

export async function shikiTokenizeLines(params: Readonly<{
    isDark: boolean;
    language: string;
    lines: readonly string[];
    colors?: Record<string, unknown> | null;
}>): Promise<Readonly<{ tokensByLine: readonly (readonly ShikiInlineToken[])[]; fg: string }>> {
    const languageId = resolveShikiLanguageId(params.language) as unknown as string;
    const themeId = resolveHappierShikiThemeId({ isDark: params.isDark, colors: params.colors });
    const code = params.lines.join('\n');
    const tokenizationCacheKey = buildShikiTokenizationCacheKey({ code, languageId, themeId });
    const cachedTokens = shikiTokenizationCache.get(tokenizationCacheKey);
    if (cachedTokens) return cachedTokens;

    const { highlighter } = await getShikiHighlighterForTheme({ themeId, isDark: params.isDark, colors: params.colors, languageId });

    const cachedEntry = highlighterCache.get(buildShikiHighlighterCacheKey({ themeId, languageId }));
    if (cachedEntry) {
        await ensureLanguageLoaded({ highlighter: cachedEntry.highlighter, loadedLanguageIds: cachedEntry.loadedLanguageIds, languageId });
    }

    const res = highlighter.codeToTokens(code, {
        lang: languageId as unknown as BundledLanguage,
        theme: themeId as unknown as BundledTheme,
    }) as unknown as TokensResult;

    const fg = typeof (res as any).fg === 'string' ? (res as any).fg : '#000';
    const tokens2d = ((res as any).tokens ?? []) as ShikiCodeToTokensResult['tokens'];

    const out: Array<readonly ShikiInlineToken[]> = [];
    for (let i = 0; i < params.lines.length; i++) {
        const row = tokens2d[i] ?? [];
        out.push(row.map((t) => ({
            text: t.content ?? '',
            color: t.color ?? fg,
        })));
    }

    const result = { tokensByLine: out, fg };
    shikiTokenizationCache.set(tokenizationCacheKey, result);
    return result;
}
