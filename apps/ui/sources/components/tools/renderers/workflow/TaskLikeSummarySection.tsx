import * as React from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { knownTools } from '@/components/tools/catalog';
import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';


interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

type TaskOperation = 'run' | 'create' | 'list' | 'update' | 'unknown';

function inferOperation(input: any): TaskOperation {
    const op = typeof input?.operation === 'string' ? input.operation : null;
    if (op === 'run' || op === 'create' || op === 'list' || op === 'update') return op;
    if (typeof input?.subject === 'string') return 'create';
    if (typeof input?.taskId === 'string' || typeof input?.taskId === 'number') return 'update';
    if (typeof input?.prompt === 'string' || typeof input?.description === 'string') return 'run';
    return 'unknown';
}

function formatTaskLikeSummary(tool: ToolCall): string | null {
    const input = tool.input as any;
    const op = inferOperation(input);
    if (op === 'create') {
        const subject = typeof input?.subject === 'string' ? input.subject : null;
        return subject ? `Create task: ${subject}` : 'Create task';
    }
    if (op === 'list') return 'List tasks';
    if (op === 'update') {
        const id = typeof input?.taskId === 'string' || typeof input?.taskId === 'number' ? String(input.taskId) : null;
        const status = typeof input?.status === 'string' ? input.status : null;
        if (id && status) return `Update task ${id}: ${status}`;
        if (id) return `Update task ${id}`;
        return 'Update task';
    }
    if (op === 'run') {
        const desc = typeof input?.description === 'string' ? input.description : null;
        const prompt = typeof input?.prompt === 'string' ? input.prompt : null;
        return desc ?? prompt ?? null;
    }
    return null;
}

function coerceTaskResultText(result: unknown): string | null {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;

    const record = result as Record<string, unknown>;
    const content = record.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;

    const chunks: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if ((item as any).type !== 'text') continue;
        const text = (item as any).text;
        if (typeof text === 'string' && text.trim().length > 0) {
            chunks.push(text);
        }
    }
    const joined = chunks.join('\n').trim();
    return joined.length > 0 ? joined : null;
}

function collectTaskLikeTools(params: Readonly<{
    tool: ToolCall;
    messages: readonly Message[];
    metadata: Metadata | null;
}>): readonly FilteredTool[] {
    const filtered: FilteredTool[] = [];
    const taskStartedAt = params.tool.startedAt ?? params.tool.createdAt;

    for (const m of params.messages) {
        if (m.kind !== 'tool-call') continue;
        // Heuristic: show tool calls that happened during/after this task started.
        if (typeof taskStartedAt === 'number' && typeof m.tool.createdAt === 'number' && m.tool.createdAt < taskStartedAt) {
            continue;
        }
        if (m.tool.name === 'Task') continue;
        const knownTool = knownTools[m.tool.name as keyof typeof knownTools] as any;

        let title = m.tool.name;
        if (knownTool) {
            if ('extractDescription' in knownTool && typeof knownTool.extractDescription === 'function') {
                title = knownTool.extractDescription({ tool: m.tool, metadata: params.metadata });
            } else if (knownTool.title) {
                if (typeof knownTool.title === 'function') {
                    title = knownTool.title({ tool: m.tool, metadata: params.metadata });
                } else {
                    title = knownTool.title;
                }
            }
        }

        if (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error') {
            filtered.push({ tool: m.tool, title, state: m.tool.state });
        }
    }

    return filtered;
}

export const TaskLikeSummarySection = React.memo<{
    tool: ToolCall;
    metadata: Metadata | null;
    messages: readonly Message[];
    detailLevel?: 'title' | 'summary' | 'full';
    opts?: Readonly<{
        hideResultInlineWhenBackgroundRun?: boolean;
    }>;
}>(function TaskLikeSummarySection({ tool, metadata, messages, detailLevel = 'summary', opts }) {
    const { theme } = useUnistyles();
    if (detailLevel === 'title') return null;

    const filtered = React.useMemo(
        () => collectTaskLikeTools({ tool, messages, metadata }),
        [tool, messages, metadata],
    );
    const isFullView = detailLevel === 'full';
    const inferredOperation = inferOperation(tool.input);
    const isBackgroundRun =
        inferredOperation === 'run' &&
        ((tool.input as any)?.run_in_background === true || typeof (tool.input as any)?.subagent_type === 'string');
    const shouldShowResultInline = isFullView || !(opts?.hideResultInlineWhenBackgroundRun ?? true) || !isBackgroundRun;
    const taskResultContent = shouldShowResultInline ? coerceTaskResultText(tool.result) : null;

    const summary = formatTaskLikeSummary(tool);
    const visibleTools = isFullView ? filtered : filtered.slice(Math.max(0, filtered.length - 3));
    const remainingCount = Math.max(0, filtered.length - visibleTools.length);
    const textMessages = messages.filter((m) => m.kind === 'user-text' || m.kind === 'agent-text');
    const threadTextMessages = isFullView ? textMessages : [];

    const hasAnyContent = Boolean(summary) || Boolean(taskResultContent) || filtered.length > 0 || threadTextMessages.length > 0;
    if (!hasAnyContent) return null;

    const styles = StyleSheet.create({
        container: {
            paddingVertical: 4,
            paddingBottom: 12,
        },
        summaryItem: {
            paddingVertical: 6,
            paddingHorizontal: 4,
        },
        summaryText: {
            fontSize: 14,
            color: theme.colors.textSecondary,
            lineHeight: 18,
        },
        toolItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 4,
            paddingLeft: 4,
            paddingRight: 2,
        },
        toolTitle: {
            fontSize: 14,
            fontWeight: '500',
            color: theme.colors.textSecondary,
            fontFamily: 'monospace',
            flex: 1,
        },
        statusContainer: {
            marginLeft: 'auto',
            paddingLeft: 8,
        },
        moreToolsItem: {
            paddingVertical: 4,
            paddingHorizontal: 4,
        },
        moreToolsText: {
            fontSize: 14,
            color: theme.colors.textSecondary,
            fontStyle: 'italic',
            opacity: 0.7,
        },
    });

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {summary ? (
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryText} numberOfLines={isFullView ? undefined : 3}>
                            {summary}
                        </Text>
                    </View>
                ) : null}
                {taskResultContent ? (
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryText} numberOfLines={isFullView ? undefined : 3}>
                            {taskResultContent}
                        </Text>
                    </View>
                ) : null}
                {visibleTools.map((item, index) => (
                    <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                        <Text style={styles.toolTitle}>{item.title}</Text>
                        <View style={styles.statusContainer}>
                            {item.state === 'running' && (
                                <ActivityIndicator size={Platform.OS === 'ios' ? 'small' : (14 as any)} color={theme.colors.warning} />
                            )}
                            {item.state === 'completed' && (
                                <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
                            )}
                            {item.state === 'error' && (
                                <Ionicons name="close-circle" size={16} color={theme.colors.textDestructive} />
                            )}
                        </View>
                    </View>
                ))}
                {remainingCount > 0 && (
                    <View style={styles.moreToolsItem}>
                        <Text style={styles.moreToolsText}>
                            {t('tools.taskView.moreTools', { count: remainingCount })}
                        </Text>
                    </View>
                )}
                {threadTextMessages.length > 0 && (
                    <View style={styles.summaryItem}>
                        {threadTextMessages.map((m, idx) => (
                            <Text
                                key={`thread-text-${idx}`}
                                style={styles.summaryText}
                                numberOfLines={isFullView ? undefined : 3}
                            >
                                {m.text}
                            </Text>
                        ))}
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});

