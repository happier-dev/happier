import React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { BundledLanguage, BundledTheme, HighlighterGeneric, TokensResult } from 'shiki';

import { CodeLinesViewCore, type CodeLinesViewProps } from './CodeLinesViewCore';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';

type ShikiInlineToken = Readonly<{ text: string; color: string }>;
type ShikiToken = Readonly<{ content: string; color?: string }>;
type ShikiCodeToTokensResult = Readonly<{ tokens: readonly (readonly ShikiToken[])[]; fg?: string }>;
type ShikiHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

const shikiHighlighterCache = new Map<string, Promise<ShikiHighlighter>>();

function resolveShikiLanguageId(language: string): BundledLanguage {
    const lower = language.trim().toLowerCase();
    const mapped = lower === 'typescript'
        ? 'ts'
        : lower === 'javascript'
            ? 'js'
            : lower === 'py'
                ? 'python'
                : lower;
    // Shiki is tolerant at runtime; typing is stricter than our resolver. Fallback to "text" if missing.
    return (mapped || 'text') as unknown as BundledLanguage;
}

async function getShikiHighlighter(params: { theme: string; language: string }): Promise<ShikiHighlighter> {
    const key = `${params.theme}:${params.language}`;
    const existing = shikiHighlighterCache.get(key);
    if (existing) {
        try {
            return await existing;
        } catch {
            // If initialization failed (transient bundler/module issues, partial cache poisoning),
            // evict and allow a future attempt to retry.
            shikiHighlighterCache.delete(key);
        }
    }

    const promise: Promise<ShikiHighlighter> = (async () => {
        const shiki = await import('shiki');
        const lang = resolveShikiLanguageId(params.language);

        return shiki.createHighlighter({
            themes: [params.theme],
            langs: [lang],
        });
    })().catch((err) => {
        shikiHighlighterCache.delete(key);
        throw err;
    });

    shikiHighlighterCache.set(key, promise);
    return promise;
}

export function CodeLinesView(props: CodeLinesViewProps) {
    const { theme } = useUnistyles();

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: props.lines, config: props.syntaxHighlighting });
    }, [props.lines, props.syntaxHighlighting]);

    const [advancedTokensByIndex, setAdvancedTokensByIndex] = React.useState<readonly (readonly ShikiInlineToken[] | null)[] | null>(null);
    const [advancedTokensRevision, setAdvancedTokensRevision] = React.useState(0);

    const shikiTheme = theme.dark ? 'github-dark' : 'github-light';
    const shikiEnabled = effectiveSyntaxHighlighting.mode === 'advanced'
        && Platform.OS === 'web'
        && Boolean(effectiveSyntaxHighlighting.language);

    const codeLinesForShiki = React.useMemo(() => {
        if (!shikiEnabled) return null;
        return props.lines.map((l) => (l.renderIsHeaderLine ? '' : (l.renderCodeText ?? '')));
    }, [props.lines, shikiEnabled]);

    React.useEffect(() => {
        if (!shikiEnabled) {
            setAdvancedTokensByIndex(null);
            return;
        }
        const syntaxLanguage = effectiveSyntaxHighlighting.language;
        if (!syntaxLanguage) {
            setAdvancedTokensByIndex(null);
            return;
        }
        const inputLines = codeLinesForShiki;
        if (!inputLines) return;

        let cancelled = false;

        void (async () => {
            try {
                const highlighter = await getShikiHighlighter({
                    theme: shikiTheme,
                    language: syntaxLanguage,
                });

                const lang = resolveShikiLanguageId(syntaxLanguage);
                const res = highlighter.codeToTokens(inputLines.join('\n'), {
                    lang,
                    theme: shikiTheme as unknown as BundledTheme,
                }) as unknown as TokensResult;

                const fg = typeof (res as any).fg === 'string' ? (res as any).fg : '#000';
                const tokens2d = ((res as any).tokens ?? []) as ShikiCodeToTokensResult['tokens'];

                const out: Array<readonly ShikiInlineToken[] | null> = [];
                for (let i = 0; i < props.lines.length; i++) {
                    const line: CodeLine | undefined = props.lines[i];
                    if (!line || line.renderIsHeaderLine) {
                        out.push(null);
                        continue;
                    }
                    if ((line.renderCodeText ?? '').length > effectiveSyntaxHighlighting.maxLineLength) {
                        out.push(null);
                        continue;
                    }
                    const row = tokens2d[i] ?? [];
                    out.push(row.map((t) => ({
                        text: t.content ?? '',
                        color: t.color ?? fg,
                    })));
                }

                if (cancelled) return;
                setAdvancedTokensByIndex(out);
                setAdvancedTokensRevision((v) => v + 1);
            } catch {
                if (cancelled) return;
                setAdvancedTokensByIndex(null);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        codeLinesForShiki,
        effectiveSyntaxHighlighting.language,
        effectiveSyntaxHighlighting.maxLineLength,
        props.lines,
        shikiEnabled,
        shikiTheme,
    ]);

    return (
        <CodeLinesViewCore
            {...props}
            advancedTokensRevision={advancedTokensRevision}
            getAdvancedTokens={(idx) => advancedTokensByIndex?.[idx] ?? null}
        />
    );
}
