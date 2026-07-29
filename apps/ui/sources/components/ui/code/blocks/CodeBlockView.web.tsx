import * as React from 'react';
import type { TextStyle } from 'react-native';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { SimpleSyntaxHighlighter } from '@/components/ui/media/SimpleSyntaxHighlighter';
import { useCodeSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeSyntaxHighlighting';
import { evaluateCodeHighlightingBudget } from '@/components/ui/code/highlighting/evaluateCodeHighlightingBudget';
import type { ShikiInlineToken } from '@/components/ui/code/highlighting/shiki/shikiTokenize.web';
import { shikiTokenizeLines } from '@/components/ui/code/highlighting/shiki/shikiTokenize.web';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveCodeMonoFontFamily } from '../codeTypography';

import type { CodeBlockViewProps } from './codeBlockViewTypes';
import { CodeBlockViewFrame } from './CodeBlockViewFrame';

export const CodeBlockView = React.memo<CodeBlockViewProps>(({
    code,
    language = null,
    showHeaderRow = true,
    selectable = true,
    wrap = false,
    showCopyButton = false,
    headerLeft,
    headerRight,
    scrollTestID,
}) => {
    const { theme } = useUnistyles();
    const isDark = theme.dark === true;

    const syntax = useCodeSyntaxHighlighting({ language });

    const maxBytes = syntax.maxBytes ?? 0;
    const maxLines = syntax.maxLines ?? 0;
    const maxLineLength = syntax.maxLineLength ?? 0;

    const budget = React.useMemo(() => {
        return evaluateCodeHighlightingBudget(code, { maxBytes, maxLines, maxLineLength });
    }, [code, maxBytes, maxLineLength, maxLines]);

    const shikiEnabled = Platform.OS === 'web'
        && syntax.mode === 'advanced'
        && Boolean(syntax.language)
        && budget.withinBudget;

    const simpleEnabled = syntax.mode === 'simple'
        && Boolean(syntax.language)
        && budget.withinBudget;

    const [tokensByLine, setTokensByLine] = React.useState<readonly (readonly ShikiInlineToken[])[] | null>(null);
    const [tokensRevision, setTokensRevision] = React.useState(0);

    const lines = budget.lines;

    React.useEffect(() => {
        if (!shikiEnabled) {
            setTokensByLine(null);
            return;
        }
        const lang = syntax.language;
        if (!lang) {
            setTokensByLine(null);
            return;
        }

        if (!lines) {
            setTokensByLine(null);
            return;
        }

        let cancelled = false;
        fireAndForget((async () => {
            try {
                const { tokensByLine: out } = await shikiTokenizeLines({ isDark, language: lang, lines, colors: theme.colors });
                if (cancelled) return;
                setTokensByLine(out);
                setTokensRevision((v) => v + 1);
            } catch {
                if (cancelled) return;
                setTokensByLine(null);
            }
        })());

        return () => {
            cancelled = true;
        };
    }, [isDark, lines, shikiEnabled, syntax.language, theme.colors]);

    const webWhitespaceStyle: TextStyle | null = React.useMemo(() => {
        // React Native Web supports CSS `white-space` and `word-break`, but React Native's `TextStyle` typing does not.
        return ({
            whiteSpace: wrap ? 'pre-wrap' : 'pre',
            wordBreak: 'break-word',
        } as unknown as TextStyle);
    }, [wrap]);

    const content = shikiEnabled && lines && tokensByLine ? (
        <View collapsable={false} data-happier-codeblock-rev={String(tokensRevision)}>
                    <Text
                        selectable={selectable}
                        style={[
                            {
                                fontFamily: resolveCodeMonoFontFamily(),
                                fontSize: 14,
                                lineHeight: 20,
                                color: theme.colors.text.primary,
                    },
                    webWhitespaceStyle,
                ]}
            >
                {tokensByLine.map((row, rowIndex) => (
                    <React.Fragment key={rowIndex}>
                        {row.map((token, tokenIndex) => (
                            <Text key={tokenIndex} selectable={selectable} style={{ color: token.color }}>
                                {token.text}
                            </Text>
                        ))}
                        {rowIndex < tokensByLine.length - 1 ? '\n' : null}
                    </React.Fragment>
                ))}
            </Text>
        </View>
    ) : simpleEnabled ? (
        <SimpleSyntaxHighlighter
            code={code}
            language={syntax.language}
            selectable={selectable}
            wrap={wrap}
        />
    ) : (
        <Text
            selectable={selectable}
            style={[
                {
                    fontFamily: resolveCodeMonoFontFamily(),
                    fontSize: 14,
                    lineHeight: 20,
                    color: theme.colors.text.primary,
                },
                webWhitespaceStyle,
            ]}
        >
            {code}
        </Text>
    );

    return (
        <CodeBlockViewFrame
            code={code}
            language={language}
            showHeaderRow={showHeaderRow}
            selectable={selectable}
            wrap={wrap}
            showCopyButton={showCopyButton}
            headerLeft={headerLeft}
            headerRight={headerRight}
            scrollTestID={scrollTestID}
        >
            {content}
        </CodeBlockViewFrame>
    );
});
