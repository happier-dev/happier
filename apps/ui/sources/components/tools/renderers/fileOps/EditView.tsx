import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { ToolViewProps } from '../core/_registry';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { trimIdent } from '@/utils/strings/trimIdent';
import { useSetting } from '@/sync/domains/state/storage';

import { Text } from '@/components/ui/text/Text';

const TEXT_ARROW = '→';

function extractEditStrings(input: any): { old: string; next: string; filePath: string | null } {
    // 1) ACP nested format: tool.input.toolCall.content[0]
    if (input?.toolCall?.content?.[0]) {
        const content = input.toolCall.content[0];
        return {
            old: content.oldText || content.old_string || '',
            next: content.newText || content.new_string || '',
            filePath: typeof content.file_path === 'string'
                ? content.file_path
                : typeof content.filePath === 'string'
                    ? content.filePath
                    : null,
        };
    }

    // 2) ACP array format: tool.input.input[0]
    if (Array.isArray(input?.input) && input.input[0]) {
        const content = input.input[0];
        return {
            old: content.oldText || content.old_string || '',
            next: content.newText || content.new_string || '',
            filePath: typeof content.file_path === 'string'
                ? content.file_path
                : typeof content.filePath === 'string'
                    ? content.filePath
                    : null,
        };
    }

    // 3) Flat formats
    return {
        old: input?.oldText || input?.old_string || '',
        next: input?.newText || input?.new_string || '',
        filePath: typeof input?.file_path === 'string'
            ? input.file_path
            : typeof input?.filePath === 'string'
                ? input.filePath
                : null,
    };
}

function truncateLines(text: string, maxLines: number): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join('\n');
}

function truncateOneLine(text: string, maxChars: number): string {
    const oneLine = text.replace(/\r\n/g, '\n').split('\n')[0] ?? '';
    if (oneLine.length <= maxChars) return oneLine;
    return `${oneLine.slice(0, maxChars - 1)}…`;
}

export const EditView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    
    const extracted = extractEditStrings(tool.input);
    const oldString = trimIdent(extracted.old || '');
    const newString = trimIdent(extracted.next || '');
    const filePath = extracted.filePath;

    if (detailLevel === 'title') {
        const from = truncateOneLine(oldString, 48);
        const to = truncateOneLine(newString, 48);
        return (
            <ToolSectionView>
                <Text style={styles.summaryText} numberOfLines={1}>
                    {`${from} ${TEXT_ARROW} ${to}`}
                </Text>
            </ToolSectionView>
        );
    }

    const isFull = detailLevel === 'full';
    const maxLines = isFull ? 400 : 20;
    const truncatedOld = truncateLines(oldString, maxLines);
    const truncatedNew = truncateLines(newString, maxLines);
    const showLineNumbers = isFull ? true : !!showLineNumbersInToolViews;

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    sessionId={sessionId}
                    filePath={filePath}
                    oldText={truncatedOld} 
                    newText={truncatedNew} 
                    showLineNumbers={showLineNumbers}
                    showPlusMinusSymbols={showLineNumbers}
                />
            </ToolSectionView>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    summaryText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));
