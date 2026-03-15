import type { BundledLanguage, BundledTheme, HighlighterGeneric, TokensResult } from 'shiki';
import { createHighlighter } from 'shiki';

import { resolveShikiLanguageId } from '@/components/ui/code/highlighting/resolveShikiLanguageId';
import { getHappierTextMateThemeRegistration, HAPPIER_TEXTMATE_THEME_IDS } from '@/components/ui/code/highlighting/shiki/happierTextMateTheme';

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

export function resolveHappierShikiThemeId(params: Readonly<{ isDark: boolean }>): string {
    return params.isDark ? HAPPIER_TEXTMATE_THEME_IDS.dark : HAPPIER_TEXTMATE_THEME_IDS.light;
}

async function getShikiHighlighterForTheme(params: Readonly<{ themeId: string; isDark: boolean }>): Promise<CachedHighlighter> {
    const cached = highlighterCache.get(params.themeId);
    if (cached) {
        return { highlighter: cached.highlighter, loadedLanguageIds: cached.loadedLanguageIds };
    }

    const inflight = highlighterInflight.get(params.themeId);
    if (inflight) return await inflight;

    const promise: Promise<CachedHighlighter> = (async () => {
        const theme = getHappierTextMateThemeRegistration({ isDark: params.isDark });
        const highlighter = await createHighlighter({
            themes: [theme as any],
            langs: ['text' as unknown as BundledLanguage],
        });

        const entry = { highlighter: highlighter as any, loadedLanguageIds: new Set<string>(['text']) };
        highlighterCache.set(params.themeId, entry);
        return { highlighter: entry.highlighter, loadedLanguageIds: entry.loadedLanguageIds };
    })().finally(() => {
        // Always clear inflight to allow retries after failures.
        highlighterInflight.delete(params.themeId);
    });

    highlighterInflight.set(params.themeId, promise);
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
}>): Promise<Readonly<{ tokensByLine: readonly (readonly ShikiInlineToken[])[]; fg: string }>> {
    const themeId = resolveHappierShikiThemeId({ isDark: params.isDark });
    const { highlighter } = await getShikiHighlighterForTheme({ themeId, isDark: params.isDark });

    const languageId = resolveShikiLanguageId(params.language) as unknown as string;
    const cachedEntry = highlighterCache.get(themeId);
    if (cachedEntry) {
        await ensureLanguageLoaded({ highlighter: cachedEntry.highlighter, loadedLanguageIds: cachedEntry.loadedLanguageIds, languageId });
    }

    const res = highlighter.codeToTokens(params.lines.join('\n'), {
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

    return { tokensByLine: out, fg };
}
