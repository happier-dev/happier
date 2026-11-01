import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useCodeSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeSyntaxHighlighting';
import { evaluateCodeHighlightingBudget } from '@/components/ui/code/highlighting/evaluateCodeHighlightingBudget';
import { CodeBlockViewFrame } from './CodeBlockViewFrame';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '@/components/ui/media/SimpleSyntaxHighlighter';
import { Text } from '@/components/ui/text/Text';

import type { CodeBlockViewProps } from './codeBlockViewTypes';

export type { CodeBlockViewProps } from './codeBlockViewTypes';

export const CodeBlockView = React.memo<CodeBlockViewProps>(({
    code,
    language = null,
    selectable = true,
    wrap = false,
    showCopyButton = false,
    headerRight,
    scrollTestID,
}) => {
    const { theme } = useUnistyles();
    const syntax = useCodeSyntaxHighlighting({ language });

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

    // A single native Text spanning a wide, long block can measure correctly but
    // paint completely blank on iOS. Keep each line on its own text surface;
    // the frame still owns scrolling and copying the complete original code.
    const content = (
        <View style={{ flexShrink: 0 }}>
            {lines.map((line, index) => (
                <View key={index} style={{ minHeight: 20 }}>
                    {shouldHighlight ? (
                        <SimpleSyntaxHighlighter
                            wrap={wrap}
                            code={line}
                            language={syntax.language}
                            selectable={selectable}
                        />
                    ) : (
                        <Text
                            selectable={selectable}
                            style={{
                                fontFamily: Typography.mono().fontFamily,
                                fontSize: 14,
                                lineHeight: 20,
                                color: theme.colors.text.primary,
                                flexShrink: 0,
                            }}
                        >
                            {line}
                        </Text>
                    )}
                </View>
            ))}
        </View>
    );

    return (
        <CodeBlockViewFrame
            code={code}
            language={language}
            selectable={selectable}
            wrap={wrap}
            showCopyButton={showCopyButton}
            headerRight={headerRight}
            scrollTestID={scrollTestID}
        >
            {content}
        </CodeBlockViewFrame>
    );
});
