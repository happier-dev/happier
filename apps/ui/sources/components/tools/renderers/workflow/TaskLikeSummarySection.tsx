import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { collectTaskLikeTools } from './collectTaskLikeTools';


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
        return subject
            ? t('tools.taskLikeSummary.createTaskWithSubject', { subject })
            : t('tools.taskLikeSummary.createTask');
    }
    if (op === 'list') return t('tools.taskLikeSummary.listTasks');
    if (op === 'update') {
        const id = typeof input?.taskId === 'string' || typeof input?.taskId === 'number' ? String(input.taskId) : null;
        const status = typeof input?.status === 'string' ? input.status : null;
        if (id && status) return t('tools.taskLikeSummary.updateTaskWithIdStatus', { id, status });
        if (id) return t('tools.taskLikeSummary.updateTaskWithId', { id });
        return t('tools.taskLikeSummary.updateTask');
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

export const TaskLikeSummarySection = React.memo<{
    tool: ToolCall;
    metadata: Metadata | null;
    messages: readonly Message[];
    detailLevel?: 'title' | 'summary' | 'full';
    sessionId?: string;
    messageId?: string;
    opts?: Readonly<{
        hideResultInlineWhenBackgroundRun?: boolean;
    }>;
}>(function TaskLikeSummarySection({ tool, metadata, messages, detailLevel = 'summary', sessionId, messageId, opts }) {
    const { theme } = useUnistyles();
    const router = useRouter();
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

    const canOpenDetails = Boolean(sessionId && messageId) && !isFullView;
    const handleOpenDetails = React.useCallback(() => {
        if (!sessionId || !messageId) return;
        router.push(`/session/${sessionId}/message/${messageId}`);
    }, [messageId, router, sessionId]);

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
                {remainingCount > 0 ? (
                    canOpenDetails ? (
                        <Pressable
                            testID="task-like-summary-more-tools"
                            accessibilityRole="button"
                            onPress={handleOpenDetails}
                            style={({ pressed }) => [styles.moreToolsItem, pressed && { opacity: 0.8 }]}
                        >
                            <Text style={styles.moreToolsText}>
                                {t('tools.taskView.moreTools', { count: remainingCount })}
                            </Text>
                        </Pressable>
                    ) : (
                        <View testID="task-like-summary-more-tools" style={styles.moreToolsItem}>
                            <Text style={styles.moreToolsText}>
                                {t('tools.taskView.moreTools', { count: remainingCount })}
                            </Text>
                        </View>
                    )
                ) : null}
                {visibleTools.map((item, index) => (
                    <View key={`${item.tool.name}-${index}`} testID="task-like-summary-tool-item" style={styles.toolItem}>
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
