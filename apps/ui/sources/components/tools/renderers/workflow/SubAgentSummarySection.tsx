import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { View, Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import { t } from '@/text';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { Text } from '@/components/ui/text/Text';
import { collectSubAgentSummaryTools } from './collectSubAgentSummaryTools';
import { buildToolCallMessageRouteId } from "@happier-dev/session-core/messages";
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { Icon } from '@/components/ui/icons/Icon';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


type TaskOperation = 'run' | 'create' | 'list' | 'update' | 'unknown';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function inferOperation(value: unknown): TaskOperation {
    const input = asRecord(value);
    const op = typeof input?.operation === 'string' ? input.operation : null;
    if (op === 'run' || op === 'create' || op === 'list' || op === 'update') return op;
    if (typeof input?.subject === 'string') return 'create';
    if (typeof input?.taskId === 'string' || typeof input?.taskId === 'number') return 'update';
    if (typeof input?.prompt === 'string' || typeof input?.description === 'string') return 'run';
    return 'unknown';
}

function formatTaskLikeSummary(tool: ToolCall): string | null {
    const input = asRecord(tool.input);
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
        const record = asRecord(item);
        if (record?.type !== 'text') continue;
        const text = record.text;
        if (typeof text === 'string' && text.trim().length > 0) {
            chunks.push(text);
        }
    }
    const joined = chunks.join('\n').trim();
    return joined.length > 0 ? joined : null;
}

export const projectSubAgentSummaryDisplayText: ToolDisplayTextProjector = (tool, metadata, context) => [
    ...toolTextBlock('tool-summary', formatTaskLikeSummary(tool)),
    ...toolTextBlock('tool-result', coerceTaskResultText(tool.result)),
    ...collectSubAgentSummaryTools({ tool, metadata: metadata ?? null, messages: context?.messages ?? [] })
        .flatMap((item, index) => toolTextBlock(`tool-child-title-${index}`, item.title)),
    ...(context?.messages ?? []).filter((message) => message.kind === 'user-text' || message.kind === 'agent-text')
        .flatMap((message, index) => toolTextBlock(`tool-thread-text-${index}`, message.text)),
];

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingVertical: 4,
    },
    summaryItem: {
        paddingVertical: 6,
        paddingHorizontal: 4,
    },
    summaryText: {
        fontSize: 14,
        color: theme.colors.text.secondary,
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
        color: theme.colors.text.secondary,
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
        color: theme.colors.text.secondary,
        fontStyle: 'italic',
        opacity: 0.7,
    },
}));

export const SubAgentSummarySection = React.memo<{
    tool: ToolCall;
    metadata: Metadata | null;
    messages: readonly Message[];
    detailLevel?: 'title' | 'summary' | 'full';
    sessionId?: string;
    /** The Home the transcript is being read on, so the detail link stays exact. */
    serverId?: string;
    messageId?: string;
    interaction?: TranscriptInteraction;
    opts?: Readonly<{
        hideResultInlineWhenBackgroundRun?: boolean;
    }>;
}>(function SubAgentSummarySection({ tool, metadata, messages, detailLevel = 'summary', sessionId, serverId, messageId, interaction, opts }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const transcriptSource = useSessionTranscriptSource();
    const find = useToolFindState(messageId);
    const effectiveDetailLevel = find.active ? 'full' : detailLevel;

    const filtered = React.useMemo(
        () => (effectiveDetailLevel === 'title' ? [] : collectSubAgentSummaryTools({ tool, messages, metadata })),
        [effectiveDetailLevel, tool, messages, metadata],
    );
    const routeMessageId = React.useMemo(() => {
        return buildToolCallMessageRouteId({
            toolId: typeof tool.id === 'string' ? tool.id : null,
            fallbackMessageId: messageId,
        });
    }, [messageId, tool.id]);

    const canOpenDetails = Boolean(sessionId && routeMessageId)
        && detailLevel !== 'full'
        && transcriptSource.navigate !== null;
    const handleOpenDetails = React.useCallback(() => {
        if (!sessionId || !routeMessageId || transcriptSource.navigate === null) return;
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(buildScopedSessionRouteHref({
                sessionId,
                serverId,
                suffix: `/message/${encodeURIComponent(routeMessageId)}`,
            }));
        });
    }, [routeMessageId, transcriptSource, serverId, sessionId]);

    if (effectiveDetailLevel === 'title') return null;

    const isFullView = effectiveDetailLevel === 'full';
    const inferredOperation = inferOperation(tool.input);
    const isBackgroundRun =
        inferredOperation === 'run' &&
        (asRecord(tool.input)?.run_in_background === true || typeof asRecord(tool.input)?.subagent_type === 'string');
    const shouldShowResultInline = isFullView || !(opts?.hideResultInlineWhenBackgroundRun ?? true) || !isBackgroundRun;
    const taskResultContent = shouldShowResultInline ? coerceTaskResultText(tool.result) : null;

    const summary = formatTaskLikeSummary(tool);
    const visibleTools = isFullView ? filtered : filtered.slice(Math.max(0, filtered.length - 3));
    const remainingCount = Math.max(0, filtered.length - visibleTools.length);
    const textMessages = messages.filter((m) => m.kind === 'user-text' || m.kind === 'agent-text');
    const threadTextMessages = isFullView ? textMessages : [];

    const hasAnyContent = Boolean(summary) || Boolean(taskResultContent) || filtered.length > 0 || threadTextMessages.length > 0;
    if (!hasAnyContent) return null;

    return (
        <View style={styles.container}>
            {summary ? (
                <View style={styles.summaryItem}>
                    <ToolFindText messageId={messageId} blockId="tool-summary" text={summary} style={styles.summaryText} numberOfLines={isFullView ? undefined : 3} />
                </View>
            ) : null}
            {taskResultContent ? (
                <View style={styles.summaryItem}>
                    <ToolFindText messageId={messageId} blockId="tool-result" text={taskResultContent} style={styles.summaryText} numberOfLines={isFullView ? undefined : 3} />
                </View>
            ) : null}
            {remainingCount > 0 ? (
                canOpenDetails ? (
                    <Pressable
                        testID="task-like-summary-more-tools"
                        accessibilityRole="button"
                        onPress={handleOpenDetails}
                        style={({ pressed }) => [styles.moreToolsItem, pressed && { opacity: motionTokens.press.opacitySubtle }]}
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
                    <ToolFindText messageId={messageId} blockId={`tool-child-title-${isFullView ? index : filtered.length - visibleTools.length + index}`} text={item.title} style={styles.toolTitle} />
                    <View style={styles.statusContainer}>
                        {item.state === 'running' && (
                            <ActivitySpinner size={Platform.OS === 'ios' ? 'small' : 14} color={theme.colors.state.neutral.foreground} />
                        )}
                        {item.state === 'completed' && (
                            <Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />
                        )}
                        {item.state === 'error' && (
                            <Icon name="x-circle" size={16} color={theme.colors.state.danger.foreground} />
                        )}
                    </View>
                </View>
            ))}
            {threadTextMessages.length > 0 && (
                <View style={styles.summaryItem}>
                    {threadTextMessages.map((m, idx) => (
                        <ToolFindText
                            key={`thread-text-${idx}`}
                            messageId={messageId}
                            blockId={`tool-thread-text-${idx}`}
                            text={m.text}
                            style={styles.summaryText}
                            numberOfLines={isFullView ? undefined : 3}
                        />
                    ))}
                </View>
            )}
        </View>
    );
});
