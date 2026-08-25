import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useCodeSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeSyntaxHighlighting';
import { evaluateCodeHighlightingBudget } from '@/components/ui/code/highlighting/evaluateCodeHighlightingBudget';
import { CodeBlockViewFrame } from './CodeBlockViewFrame';
import { SimpleSyntaxHighlighter } from '@/components/ui/media/SimpleSyntaxHighlighter';
import { Text } from '@/components/ui/text/Text';
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

    const content = shouldHighlight ? (
        <SimpleSyntaxHighlighter
            code={code}
            language={syntax.language}
            selectable={selectable}
            wrap={wrap}
        />
    ) : (
        <Text
            selectable={selectable}
            style={{
                fontFamily: resolveCodeMonoFontFamily(),
                fontSize: 14,
                lineHeight: 20,
                color: theme.colors.text.primary,
                flexShrink: wrap ? undefined : 0,
            }}
        >
            {code}
        </Text>
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
        >
            {content}
        </CodeBlockViewFrame>
    );
});
