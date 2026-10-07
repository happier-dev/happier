import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { t } from '@/text';


function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function getText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string' && parsed.trim()) return parsed;
    const obj = asRecord(parsed);
    if (!obj) return null;
    const candidates = [obj.text, obj.content, obj.body, obj.markdown, obj.result, obj.output];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
    }
    return null;
}

function getStatus(result: unknown): number | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (!obj) return null;
    return typeof obj.status === 'number' ? obj.status : null;
}

export const projectWebFetchDisplayText: ToolDisplayTextProjector = (tool) => {
    if (tool.state !== 'completed') return [];
    const url = typeof tool.input?.url === 'string' ? tool.input.url : null;
    const status = getStatus(tool.result);
    return [
        ...toolTextBlock('tool-fetch-url', url),
        ...toolTextBlock('tool-fetch-status', url && typeof status === 'number' ? t('tools.webFetch.httpStatus', { status }) : null),
        ...toolTextBlock('tool-fetch-body', getText(tool.result)),
    ];
};

export const WebFetchView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (tool.state !== 'completed') return null;
    const blocks = projectWebFetchDisplayText(tool);
    const url = blocks.find((block) => block.id === 'tool-fetch-url')?.text;
    const text = blocks.find((block) => block.id === 'tool-fetch-body')?.text;
    const status = blocks.find((block) => block.id === 'tool-fetch-status')?.text;
    if (!url && !text) return null;

    return (
        <ToolSectionView fullWidth={detailLevel === 'full'}>
            <View style={styles.container}>
                {url ? (
                    <View style={styles.header}>
                        <ToolFindText text={url} blockId="tool-fetch-url" messageId={messageId} style={styles.url} numberOfLines={2} />
                        {status ? (
                            <ToolFindText text={status} blockId="tool-fetch-status" messageId={messageId} style={styles.status} />
                        ) : null}
                    </View>
                ) : null}
                {text ? <CodeView code={detailLevel === 'full' || find.active ? text : truncate(text, 2200)} findRanges={find.ranges('tool-fetch-body')} /> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    header: {
        flexDirection: 'row',
        gap: 8,
    },
    url: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    status: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
