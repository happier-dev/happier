import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ToolFindText } from '../core/ToolFindText';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { t } from '@/text';

import type { ToolViewProps } from '../core/_registry';
import { maybeParseJson } from '@happier-dev/protocol';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

/**
 * `TaskStop` stops a *background task*, not a subagent. It is a real Claude Agent SDK tool
 * (`TaskStopInput`), and unlike `TaskOutput` it has an attested result shape (`TaskStopOutput`:
 * `message`, `task_id`, `task_type`, optional `command`), so the card can name what was stopped.
 *
 * The command is rendered verbatim: redaction in this program is scoped to the durable
 * `activity/background_task.v1` record, and the transcript deliberately stays the place where the
 * real command text lives.
 */
export const projectTaskStopDisplayText: ToolDisplayTextProjector = (tool) => {
    const result = asRecord(maybeParseJson(tool.result));
    const command = readString(result?.command);
    return [
        ...toolTextBlock('tool-task-stop-label', command ? t('tools.taskStopView.stoppedCommandLabel') : null),
        ...toolTextBlock('tool-task-stop-command', command),
        ...toolTextBlock('tool-task-stop-message', readString(result?.message)),
    ];
};

export const TaskStopView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    if (detailLevel === 'title') return null;

    const blocks = projectTaskStopDisplayText(tool);
    const stoppedCommand = blocks.find((block) => block.id === 'tool-task-stop-command')?.text;
    const message = blocks.find((block) => block.id === 'tool-task-stop-message')?.text;

    if (!stoppedCommand && !message) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {stoppedCommand ? (
                    <>
                        <ToolFindText text={t('tools.taskStopView.stoppedCommandLabel')} blockId="tool-task-stop-label" messageId={messageId} style={styles.label} />
                        <ToolFindText text={stoppedCommand} blockId="tool-task-stop-command" messageId={messageId} style={styles.command} numberOfLines={detailLevel === 'full' ? undefined : 2} />
                    </>
                ) : null}
                {message ? (
                    <ToolFindText text={message} blockId="tool-task-stop-message" messageId={messageId} style={styles.message} numberOfLines={detailLevel === 'full' ? undefined : 2} />
                ) : null}
            </View>
        </ToolSectionView>
    );
});

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    command: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
    message: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));
