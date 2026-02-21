import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { maybeParseJson } from '../../normalization/parse/parseJson';
import { Text } from '@/components/ui/text/Text';


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

export const WebFetchView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (tool.state !== 'completed') return null;
    const url = typeof tool.input?.url === 'string' ? tool.input.url : null;
    const text = getText(tool.result);
    const status = getStatus(tool.result);
    if (!url && !text) return null;

    return (
        <ToolSectionView fullWidth={detailLevel === 'full'}>
            <View style={styles.container}>
                {url ? (
                    <View style={styles.header}>
                        <Text style={styles.url} numberOfLines={2}>
                            {url}
                        </Text>
                        {typeof status === 'number' ? (
                            <Text style={styles.status}>{`HTTP ${status}`}</Text>
                        ) : null}
                    </View>
                ) : null}
                {text ? <CodeView code={detailLevel === 'full' ? text : truncate(text, 2200)} /> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 10,
    },
    header: {
        flexDirection: 'row',
        gap: 8,
    },
    url: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    status: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
