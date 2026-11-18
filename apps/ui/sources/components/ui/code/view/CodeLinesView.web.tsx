import React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { CodeLinesViewCore, type CodeLinesViewProps } from './CodeLinesViewCore';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ShikiInlineToken } from '@/components/ui/code/highlighting/shiki/shikiTokenize';
import { readShikiTokenizedLines, shikiTokenizeLines } from '@/components/ui/code/highlighting/shiki/shikiTokenize';

export function CodeLinesView(props: CodeLinesViewProps) {
    const { theme } = useUnistyles();
    const syntaxLines = props.syntaxHighlightingLines ?? props.lines;

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: syntaxLines, config: props.syntaxHighlighting });
    }, [syntaxLines, props.syntaxHighlighting]);

    const [loadedAdvancedTokensByLine, setLoadedAdvancedTokens] = React.useState<ReadonlyMap<CodeLine, readonly ShikiInlineToken[]> | null>(null);
    const [advancedTokensRevision, setAdvancedTokensRevision] = React.useState(0);

    const isDark = theme.dark === true;
    const shikiEnabled = effectiveSyntaxHighlighting.mode === 'advanced'
        && Platform.OS === 'web'
        && Boolean(effectiveSyntaxHighlighting.language);

    const codeLinesForShiki = React.useMemo(() => {
        if (!shikiEnabled) return null;
        return syntaxLines.map((l) => (l.renderIsHeaderLine ? '' : (l.renderCodeText ?? '')));
    }, [syntaxLines, shikiEnabled]);

    const indexTokensByLine = React.useCallback((tokensByLine: readonly (readonly ShikiInlineToken[])[]) => {
        const out = new Map<CodeLine, readonly ShikiInlineToken[]>();
        for (let i = 0; i < syntaxLines.length; i++) {
            const line = syntaxLines[i];
            if (!line || line.renderIsHeaderLine) {
                continue;
            }
            if ((line.renderCodeText ?? '').length > effectiveSyntaxHighlighting.maxLineLength) {
                continue;
            }
            const row = tokensByLine[i];
            if (row) out.set(line, row);
        }
        return out;
    }, [effectiveSyntaxHighlighting.maxLineLength, syntaxLines]);

    // With the highlighter and grammar already loaded, the lines mount with their colors instead of drawing plain
    // text first and redrawing every line when the tokens arrive.
    const readyAdvancedTokensByLine = React.useMemo(() => {
        const syntaxLanguage = effectiveSyntaxHighlighting.language;
        if (!shikiEnabled || !syntaxLanguage || !codeLinesForShiki) return null;
        const ready = readShikiTokenizedLines({ isDark, language: syntaxLanguage, lines: codeLinesForShiki, colors: theme.colors });
        return ready ? indexTokensByLine(ready.tokensByLine) : null;
    }, [codeLinesForShiki, effectiveSyntaxHighlighting.language, indexTokensByLine, isDark, shikiEnabled, theme.colors]);

    React.useEffect(() => {
        if (!shikiEnabled) {
            setLoadedAdvancedTokens(null);
            return;
        }
        const syntaxLanguage = effectiveSyntaxHighlighting.language;
        if (!syntaxLanguage) {
            setLoadedAdvancedTokens(null);
            return;
        }
        const inputLines = codeLinesForShiki;
        if (!inputLines) return;
        if (readyAdvancedTokensByLine) return;

        let cancelled = false;

        fireAndForget((async () => {
            try {
                const { tokensByLine } = await shikiTokenizeLines({
                    isDark,
                    language: syntaxLanguage,
                    lines: inputLines,
                    colors: theme.colors,
                });

                const byLine = indexTokensByLine(tokensByLine);
                if (cancelled) return;
                setLoadedAdvancedTokens(byLine);
                setAdvancedTokensRevision((v) => v + 1);
            } catch {
                if (cancelled) return;
                setLoadedAdvancedTokens(null);
            }
        })());

        return () => {
            cancelled = true;
        };
    }, [
        codeLinesForShiki,
        effectiveSyntaxHighlighting.language,
        indexTokensByLine,
        isDark,
        readyAdvancedTokensByLine,
        shikiEnabled,
        theme.colors,
    ]);

    // A ready set changes only with the lines, language or theme, which reach the core's rows by themselves.
    const advancedTokensByLine = readyAdvancedTokensByLine ?? loadedAdvancedTokensByLine;

    return (
        <CodeLinesViewCore
            {...props}
            advancedTokensRevision={advancedTokensRevision}
            getAdvancedTokens={(idx) => {
                const line = props.lines[idx];
                return line ? advancedTokensByLine?.get(line) ?? null : null;
            }}
        />
    );
}
