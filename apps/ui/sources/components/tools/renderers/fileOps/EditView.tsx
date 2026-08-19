import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { ToolViewProps } from '../core/_registry';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { trimIdent } from '@/utils/strings/trimIdent';
import { useSetting } from '@/sync/domains/state/storage';

import { Text } from '@/components/ui/text/Text';

const TEXT_ARROW = '→';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function extractDiffItem(value: unknown): Record<string, unknown> | null {
    const record = asRecord(Array.isArray(value) ? value[0] : value);
    if (!record) return null;
    if (record.type === 'diff' || 'oldText' in record || 'old_string' in record || 'newText' in record || 'new_string' in record) {
        return record;
    }
    return null;
}

function extractResultDiff(result: unknown): Record<string, unknown> | null {
    if (Array.isArray(result)) return extractDiffItem(result);
    const record = asRecord(result);
    if (!record) return null;
    return extractDiffItem(record)
        ?? extractDiffItem(record.output)
        ?? extractDiffItem(record.content)
        ?? extractDiffItem(record.result)
        ?? extractDiffItem(asRecord(record._raw)?.output);
}

function readString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
    for (const key of keys) {
        if (typeof record?.[key] === 'string') return record[key];
    }
    return null;
}

function extractEditStrings(input: unknown, result: unknown): { old: string; next: string; filePath: string | null } {
    const inputRecord = asRecord(input);
    const toolCallRecord = asRecord(inputRecord?.toolCall);
    const inputDiff = extractDiffItem(toolCallRecord?.content)
        ?? extractDiffItem(inputRecord?.input)
        ?? inputRecord;
    const resultDiff = extractResultDiff(result);
    return {
        old: readString(inputDiff, ['oldText', 'old_string'])
            ?? readString(resultDiff, ['oldText', 'old_string'])
            ?? '',
        next: readString(inputDiff, ['newText', 'new_string'])
            ?? readString(resultDiff, ['newText', 'new_string'])
            ?? '',
        filePath: readString(inputDiff, ['path', 'file_path', 'filePath'])
            ?? readString(resultDiff, ['path', 'file_path', 'filePath']),
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
    
    const extracted = extractEditStrings(tool.input, tool.result);
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
