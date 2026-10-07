import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import type { ToolViewProps } from '../core/_registry';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';

const TEXT_ELLIPSIS = '…';


function extractReadContent(result: unknown): { content: string; numLines?: number } | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
        return { content: parsed };
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const file = (obj.file && typeof obj.file === 'object' && !Array.isArray(obj.file)) ? (obj.file as Record<string, unknown>) : null;
        const content = (file && typeof file.content === 'string')
            ? file.content
            : (typeof obj.content === 'string')
                ? obj.content
                : null;
        if (!content) return null;

        const numLines = typeof file?.numLines === 'number' ? (file.numLines as number) : undefined;
        return { content, numLines };
    }

    return null;
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.length <= maxLines) return { text, truncated: false };
    return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

export const projectReadDisplayText: ToolDisplayTextProjector = (tool) => tool.state === 'completed'
    ? toolTextBlock('tool-read', extractReadContent(tool.result)?.content ?? t('tools.workflowActivityView.unavailable')) : [];

export const ReadView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (tool.state !== 'completed') return null;
    const extracted = extractReadContent(tool.result);
    if (!extracted) {
        return (
            <ToolSectionView>
                <ToolFindText text={t('tools.workflowActivityView.unavailable')} blockId="tool-read" messageId={messageId} style={styles.unavailable} />
            </ToolSectionView>
        );
    }

    // Protect the UI from extremely large reads; keep `_raw` for debugging.
    const maxLines = detailLevel === 'full' ? 400 : 20;
    const { text, truncated } = find.active ? { text: extracted.content, truncated: false } : truncateLines(extracted.content, maxLines);
    return (
        <ToolSectionView fullWidth>
            <View style={styles.container}>
                <CodeView code={text} findRanges={find.ranges('tool-read')} />
                {truncated ? <Text style={styles.more}>{TEXT_ELLIPSIS}</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    more: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    unavailable: {
        color: theme.colors.text.secondary,
    },
}));
