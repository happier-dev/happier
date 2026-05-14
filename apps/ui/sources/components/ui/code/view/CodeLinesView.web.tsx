import React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { CodeLinesViewCore, type CodeLinesViewProps } from './CodeLinesViewCore';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ShikiInlineToken } from '@/components/ui/code/highlighting/shiki/shikiTokenize.web';
import { shikiTokenizeLines } from '@/components/ui/code/highlighting/shiki/shikiTokenize.web';

export function CodeLinesView(props: CodeLinesViewProps) {
    const { theme } = useUnistyles();

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: props.lines, config: props.syntaxHighlighting });
    }, [props.lines, props.syntaxHighlighting]);

    const [advancedTokensByIndex, setAdvancedTokensByIndex] = React.useState<readonly (readonly ShikiInlineToken[] | null)[] | null>(null);
    const [advancedTokensRevision, setAdvancedTokensRevision] = React.useState(0);

    const isDark = theme.dark === true;
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

        fireAndForget((async () => {
            try {
                const { tokensByLine, fg } = await shikiTokenizeLines({
                    isDark,
                    language: syntaxLanguage,
                    lines: inputLines,
                    colors: theme.colors,
                });

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
                    const row = tokensByLine[i] ?? [];
                    out.push(row.map((t) => ({ text: t.text, color: t.color ?? fg })));
                }

                if (cancelled) return;
                setAdvancedTokensByIndex(out);
                setAdvancedTokensRevision((v) => v + 1);
            } catch {
                if (cancelled) return;
                setAdvancedTokensByIndex(null);
            }
        })());

        return () => {
            cancelled = true;
        };
    }, [
        codeLinesForShiki,
        effectiveSyntaxHighlighting.language,
        effectiveSyntaxHighlighting.maxLineLength,
        isDark,
        props.lines,
        shikiEnabled,
        theme.colors,
    ]);

    return (
        <CodeLinesViewCore
            {...props}
            advancedTokensRevision={advancedTokensRevision}
            getAdvancedTokens={(idx) => advancedTokensByIndex?.[idx] ?? null}
        />
    );
}
