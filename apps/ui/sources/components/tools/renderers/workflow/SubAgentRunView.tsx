import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolViewProps } from '@/components/tools/renderers/core/_registry';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { TaskLikeSummarySection } from './TaskLikeSummarySection';

type FindingsDigest = Readonly<{
    total: number;
    items: ReadonlyArray<
        Readonly<{
            id: string;
            title: string;
            severity: string;
            category: string;
            filePath?: string;
            startLine?: number;
            endLine?: number;
        }>
    >;
}>;

function getFindingsDigest(toolResult: unknown): FindingsDigest | null {
    if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) return null;
    const record = toolResult as Record<string, unknown>;
    const digest = record.findingsDigest as any;
    if (!digest || typeof digest !== 'object' || Array.isArray(digest)) return null;
    if (typeof digest.total !== 'number' || !Number.isFinite(digest.total) || digest.total < 0) return null;
    if (!Array.isArray(digest.items)) return null;
    const items: FindingsDigest['items'] = digest.items
        .filter((i: any) => i && typeof i === 'object' && !Array.isArray(i))
        .map((i: any) => ({
            id: typeof i.id === 'string' ? i.id : '',
            title: typeof i.title === 'string' ? i.title : '',
            severity: typeof i.severity === 'string' ? i.severity : '',
            category: typeof i.category === 'string' ? i.category : '',
            ...(typeof i.filePath === 'string' ? { filePath: i.filePath } : {}),
            ...(typeof i.startLine === 'number' ? { startLine: i.startLine } : {}),
            ...(typeof i.endLine === 'number' ? { endLine: i.endLine } : {}),
        }))
        .filter((i: any) => i.id.length > 0 && i.title.length > 0 && i.severity.length > 0 && i.category.length > 0);

    if (items.length === 0) return null;
    return { total: digest.total, items };
}

function coerceTextMessages(messages: readonly Message[]): readonly string[] {
    const out: string[] = [];
    for (const m of messages) {
        if (!m) continue;
        if (m.kind !== 'agent-text' && m.kind !== 'user-text') continue;
        const text = typeof (m as any).text === 'string' ? String((m as any).text) : '';
        if (text.trim()) out.push(text);
    }
    return out;
}

export const SubAgentRunView = React.memo<ToolViewProps>(({ tool, messages, detailLevel }) => {
    if (tool.state === 'running') {
        return (
            <TaskLikeSummarySection
                tool={tool as any}
                metadata={null}
                messages={messages ?? []}
                detailLevel={detailLevel}
                opts={{ hideResultInlineWhenBackgroundRun: false }}
            />
        );
    }

    if (tool.state !== 'completed') return null;
    if (!tool.result) return null;

    const intent =
        typeof (tool as any).input?.intent === 'string'
            ? String((tool as any).input.intent)
            : typeof (tool.result as any)?.intent === 'string'
                ? String((tool.result as any).intent)
                : null;

    const digest = getFindingsDigest(tool.result);
    if (!digest || digest.items.length === 0) {
        if (intent === 'plan') {
            const summary = typeof (tool.result as any)?.summary === 'string' ? String((tool.result as any).summary) : '';
            return (
                <View style={styles.container}>
                    <Text style={styles.title}>Plan</Text>
                    {summary ? <Text style={styles.line}>{summary}</Text> : null}
                    <StructuredResultView tool={tool} metadata={null} messages={[]} />
                </View>
            );
        }

        if (intent === 'delegate') {
            const summary = typeof (tool.result as any)?.summary === 'string' ? String((tool.result as any).summary) : '';
            return (
                <View style={styles.container}>
                    <Text style={styles.title}>Delegate</Text>
                    {summary ? <Text style={styles.line}>{summary}</Text> : null}
                    <StructuredResultView tool={tool} metadata={null} messages={[]} />
                </View>
            );
        }

        return <StructuredResultView tool={tool} metadata={null} messages={[]} />;
    }

    return (
        <View style={styles.container}>
            <Text style={styles.title}>Review digest</Text>
            {digest.items.slice(0, 20).map((item, idx) => (
                <Text key={item.id || String(idx)} style={styles.line}>
                    {item.title}
                </Text>
            ))}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 6,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    line: {
        fontSize: 12,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
}));
