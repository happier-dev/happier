import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useCodeSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeSyntaxHighlighting';
import { evaluateCodeHighlightingBudget } from '@/components/ui/code/highlighting/evaluateCodeHighlightingBudget';
import { CODE_BLOCK_LINE_HEIGHT, CodeBlockViewFrame } from './CodeBlockViewFrame';
import { SimpleSyntaxHighlighter } from '@/components/ui/media/SimpleSyntaxHighlighter';
import { Text } from '@/components/ui/text/Text';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';
import { resolveCodeMonoFontFamily } from '../codeTypography';
import { normalizeHappierCodeLanguage } from '@happier-dev/plugin-ui/presentation';

import type { CodeBlockViewProps } from './codeBlockViewTypes';

export type { CodeBlockViewProps } from './codeBlockViewTypes';

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
    containerStyle,
    findRanges,
    markedLines,
}) => {
    const { theme } = useUnistyles();
    const normalizedLanguage = normalizeHappierCodeLanguage(language) ?? null;
    const syntax = useCodeSyntaxHighlighting({ language: normalizedLanguage });

    const maxBytes = syntax.maxBytes ?? 0;
    const maxLines = syntax.maxLines ?? 0;
    const maxLineLength = syntax.maxLineLength ?? 0;

    const budget = React.useMemo(() => {
        return evaluateCodeHighlightingBudget(code, { maxBytes, maxLines, maxLineLength });
    }, [code, maxBytes, maxLineLength, maxLines]);

    const shouldHighlight = syntax.mode !== 'off'
        && Boolean(syntax.language)
        && budget.withinBudget;

    const lines = React.useMemo(
        () => budget.lines ?? budget.normalizedCode.split('\n'),
        [budget],
    );
    let lineOffset = 0;

    // A single native Text spanning a wide, long block can measure correctly but
    // paint completely blank on iOS. Keep each line on its own text surface;
    // the frame still owns scrolling and copying the complete original code.
    const content = (
        <View style={{ flexShrink: wrap ? undefined : 0 }}>
            {lines.map((line, index) => {
                const ranges = sliceFindRanges(findRanges, lineOffset, line.length);
                // Find uses offsets in the original code, including CRLF separators.
                const newline = code.indexOf('\n', lineOffset);
                lineOffset = newline < 0 ? code.length : newline + 1;
                return (
                    <View key={index} style={{ minHeight: CODE_BLOCK_LINE_HEIGHT }}>
                        {shouldHighlight ? (
                            <SimpleSyntaxHighlighter
                                code={line}
                                language={syntax.language}
                                selectable={selectable}
                                wrap={wrap}
                                findRanges={ranges}
                            />
                        ) : (
                            <Text
                                selectable={selectable}
                                style={{
                                    fontFamily: resolveCodeMonoFontFamily(),
                                    fontSize: 14,
                                    lineHeight: CODE_BLOCK_LINE_HEIGHT,
                                    color: theme.colors.text.primary,
                                    flexShrink: wrap ? undefined : 0,
                                }}
                            >
                                {ranges?.length ? <FindHighlightedText text={line} ranges={ranges} selectable={selectable} /> : line}
                            </Text>
                        )}
                    </View>
                );
            })}
        </View>
    );

    return (
        <CodeBlockViewFrame
            code={code}
            language={normalizedLanguage}
            showHeaderRow={showHeaderRow}
            selectable={selectable}
            wrap={wrap}
            showCopyButton={showCopyButton}
            headerLeft={headerLeft}
            headerRight={headerRight}
            scrollTestID={scrollTestID}
            containerStyle={containerStyle}
            markedLines={markedLines}
        >
            {content}
        </CodeBlockViewFrame>
    );
});
