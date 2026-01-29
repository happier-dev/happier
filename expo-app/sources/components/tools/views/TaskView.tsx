import * as React from 'react';
import { ToolViewProps } from './_registry';
import { Text, View, ActivityIndicator, Platform } from 'react-native';
import { knownTools } from '../../tools/knownTools';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ToolSectionView } from '../ToolSectionView';

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

function formatTaskSummary(tool: ToolCall): string | null {
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

export const TaskView = React.memo<ToolViewProps>(({ tool, metadata, messages, detailLevel }) => {
    const { theme } = useUnistyles();
    const filtered: FilteredTool[] = [];
    const isFullView = detailLevel === 'full';
    const taskStartedAt = tool.startedAt ?? tool.createdAt;

    for (let m of messages) {
        if (m.kind === 'tool-call') {
            // Heuristic: show tool calls that happened during/after this task started.
            if (typeof taskStartedAt === 'number' && typeof m.tool.createdAt === 'number' && m.tool.createdAt < taskStartedAt) {
                continue;
            }
            if (m.tool.name === 'Task') continue;
            const knownTool = knownTools[m.tool.name as keyof typeof knownTools] as any;
            
            // Extract title using extractDescription if available, otherwise use title
            let title = m.tool.name;
            if (knownTool) {
                if ('extractDescription' in knownTool && typeof knownTool.extractDescription === 'function') {
                    title = knownTool.extractDescription({ tool: m.tool, metadata });
                } else if (knownTool.title) {
                    // Handle optional title and function type
                    if (typeof knownTool.title === 'function') {
                        title = knownTool.title({ tool: m.tool, metadata });
                    } else {
                        title = knownTool.title;
                    }
                }
            }

            if (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error') {
                filtered.push({
                    tool: m.tool,
                    title,
                    state: m.tool.state
                });
            }
        }
    }

    const styles = StyleSheet.create({
        container: {
            paddingVertical: 4,
            paddingBottom: 12
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
            paddingRight: 2
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
        loadingItem: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 4,
        },
        loadingText: {
            marginLeft: 8,
            fontSize: 14,
            color: theme.colors.textSecondary,
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

    if (detailLevel === 'title') return null;

    const summary = formatTaskSummary(tool);
    const visibleTools = isFullView ? filtered.slice(Math.max(0, filtered.length - 10)) : filtered.slice(Math.max(0, filtered.length - 3));
    const remainingCount = Math.max(0, filtered.length - visibleTools.length);
    const hasAnyContent = Boolean(summary) || filtered.length > 0;
    if (!hasAnyContent) return null;

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
                {visibleTools.map((item, index) => (
                    <View key={`${item.tool.name}-${index}`} style={styles.toolItem}>
                        <Text style={styles.toolTitle}>{item.title}</Text>
                        <View style={styles.statusContainer}>
                            {item.state === 'running' && (
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={theme.colors.warning} />
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
            </View>
        </ToolSectionView>
    );
});
