import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { ToolViewProps } from '../core/_registry';
import { maybeParseJson } from '../../normalization/parse/parseJson';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

/**
 * `TaskStop` stops a *background task*, not a subagent. It is a real Claude Agent SDK tool
 * (`TaskStopInput`), and unlike `TaskOutput` it has an attested result shape (`TaskStopOutput`:
 * `message`, `task_id`, `task_type`, optional `command`), so the card can name what was stopped.
 *
 * The command is rendered verbatim: redaction in this program is scoped to the durable
 * background-task record, and the transcript deliberately stays the place where the real command
 * text lives (PLAN §4.9, "Scope boundary").
 */
export const TaskStopView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;

    const result = asRecord(maybeParseJson(tool.result));
    const stoppedCommand = readString(result?.command);
    const message = readString(result?.message);

    if (!stoppedCommand && !message) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                {stoppedCommand ? (
                    <>
                        <Text style={styles.label}>{t('tools.taskStopView.stoppedCommandLabel')}</Text>
                        <Text style={styles.command} numberOfLines={detailLevel === 'full' ? undefined : 2}>
                            {stoppedCommand}
                        </Text>
                    </>
                ) : null}
                {message ? (
                    <Text style={styles.message} numberOfLines={detailLevel === 'full' ? undefined : 2}>
                        {message}
                    </Text>
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
