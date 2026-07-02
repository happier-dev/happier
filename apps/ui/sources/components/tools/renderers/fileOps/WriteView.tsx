import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { knownTools } from '@/components/tools/catalog';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { useSetting } from '@/sync/domains/state/storage';

import { Text } from '@/components/ui/text/Text';


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

export const WriteView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');

    let contents: string = '<no contents>';
    let filePath: string | null = null;
    const parsed = knownTools.Write.input.safeParse(tool.input);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
        filePath = typeof parsed.data.file_path === 'string' ? parsed.data.file_path : null;
    }

    if (detailLevel === 'title') {
        return (
            <ToolSectionView>
                <Text style={styles.summaryText} numberOfLines={1}>{truncateOneLine(contents, 80)}</Text>
            </ToolSectionView>
        );
    }

    const isFull = detailLevel === 'full';
    const maxLines = isFull ? 400 : 20;
    const truncated = truncateLines(contents, maxLines);
    const showLineNumbers = isFull ? true : !!showLineNumbersInToolViews;

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    sessionId={sessionId}
                    filePath={filePath}
                    oldText={''} 
                    newText={truncated} 
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
