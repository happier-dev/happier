import React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { CodeLinesViewCore, type CodeLinesViewProps } from './CodeLinesViewCore';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';

type ShikiInlineToken = Readonly<{ text: string; color: string }>;
type ShikiToken = Readonly<{ content: string; color?: string }>;
type ShikiCodeToTokensResult = Readonly<{ tokens: readonly (readonly ShikiToken[])[]; fg?: string }>;
type ShikiHighlighter = Readonly<{
    codeToTokens: (code: string, params: { lang: string; theme: string }) => ShikiCodeToTokensResult;
}>;

const shikiHighlighterCache = new Map<string, Promise<ShikiHighlighter>>();

async function getShikiHighlighter(params: { theme: string; language: string }): Promise<ShikiHighlighter> {
    const key = `${params.theme}:${params.language}`;
    const existing = shikiHighlighterCache.get(key);
    if (existing) return existing;

    const promise = (async () => {
        const shiki = await import('shiki');
        // Shiki expects language ids like "ts"; our file-language resolver returns human names.
        const lang = params.language.toLowerCase() === 'typescript'
            ? 'ts'
            : params.language.toLowerCase() === 'javascript'
                ? 'js'
                : params.language.toLowerCase() === 'py'
                    ? 'python'
                    : params.language.toLowerCase();

        return shiki.createHighlighter({
            themes: [params.theme],
            langs: [lang],
        });
    })();

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
        if (!effectiveSyntaxHighlighting.language) {
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
                    language: effectiveSyntaxHighlighting.language,
                });

                const lang = effectiveSyntaxHighlighting.language.toLowerCase() === 'typescript'
                    ? 'ts'
                    : effectiveSyntaxHighlighting.language.toLowerCase() === 'javascript'
                        ? 'js'
                        : effectiveSyntaxHighlighting.language.toLowerCase() === 'py'
                            ? 'python'
                            : effectiveSyntaxHighlighting.language.toLowerCase();

                const res = highlighter.codeToTokens(inputLines.join('\n'), {
                    lang,
                    theme: shikiTheme,
                });

                const fg = typeof res.fg === 'string' ? res.fg : '#000';
                const tokens2d = res.tokens ?? [];

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

