import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { knownTools } from '@/components/tools/catalog';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { useSetting } from '@/sync/domains/state/storage';

import type { ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { useToolFindState } from '../core/ToolFindText';
import { Text } from '@/components/ui/text/Text';
import { buildToolFileDiffLines, projectToolDiffLines } from './toolDiffDisplayText';


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

function readWriteInput(input: unknown) {
    let contents: string = '<no contents>';
    let filePath: string | null = null;
    const parsed = knownTools.Write.input.safeParse(input);
    if (parsed.success && typeof parsed.data.content === 'string') {
        contents = parsed.data.content;
        filePath = typeof parsed.data.file_path === 'string' ? parsed.data.file_path : null;
    }

    return { contents, filePath };
}

export const projectWriteDisplayText: ToolDisplayTextProjector = (tool) => projectToolDiffLines(buildToolFileDiffLines({ oldText: '', newText: readWriteInput(tool.input).contents }), 'tool-write');

export const WriteView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId, serverId, messageId }) => {
    const find = useToolFindState(messageId);
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { contents, filePath } = readWriteInput(tool.input);
    if (detailLevel === 'title' && !find.active) {
        return (
            <ToolSectionView>
                <Text style={styles.summaryText} numberOfLines={1}>{truncateOneLine(contents, 80)}</Text>
            </ToolSectionView>
        );
    }

    const isFull = detailLevel === 'full';
    const maxLines = isFull ? 400 : 20;
    const truncated = find.active ? contents : truncateLines(contents, maxLines);
    const showLineNumbers = isFull ? true : !!showLineNumbersInToolViews;

    return (
        <>
            <ToolSectionView fullWidth>
                <ToolDiffView 
                    messageId={messageId}
                    findBlockPrefix="tool-write"
                    sessionId={sessionId}
                    serverId={serverId}
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
