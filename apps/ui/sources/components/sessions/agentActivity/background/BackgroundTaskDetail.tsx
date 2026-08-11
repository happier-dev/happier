import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { formatElapsedDuration } from '../presentation/formatElapsedDuration';
import { resolveAgentActivityStatusWord } from '../presentation/agentActivityToneStyle';
import { AGENT_ROW_DETAIL_INSET_PX } from '../row/agentRowMetrics';

/**
 * What a background command's detail is allowed to say (PLAN §4.9).
 *
 * **A background command is a headless process, not an agent.** It has no transcript, no sidechain
 * and no recipient, so this is not a conversation: it is the redacted label, the status, how long it
 * took, the provider's own summary, and a way to reach the `Bash` card that launched it.
 *
 * Everything this deliberately does NOT render, each of which was a fabrication caught in review:
 *
 * - **No output tail, no `CodeLinesView`, no follow/pause.** The durable record has no output field.
 *   `stdout`/`stderr` arrive on the originating `Bash` tool result and the transcript already
 *   renders them there; a second copy would be a second authority over the same bytes, which is why
 *   the deep link exists instead.
 * - **No `cwd`.** It appears in no observed Claude task payload.
 * - **No exit code.** The record carries none, because no producer for one exists in this SDK.
 *   Failed-without-a-code is the designed state: the copy reads `Failed` and stops there.
 * - **No retention promise.** No TTL mechanism exists, so no line may imply one.
 * - **No fabricated timestamp** (D-8). Without a genuine start, or without a genuine end on a
 *   finished task, no duration is rendered at all — never `0:00`.
 */

export type BackgroundTaskDetailProps = Readonly<{
    record: SessionBackgroundTaskRecordV1;
    /**
     * Opens the `Bash` transcript card that launched this command.
     *
     * Absent when this client cannot point at one — the transcript page holding it has not arrived,
     * or the provider result carried no task id to join on. Affordance is the presence of data: no
     * callback, no link, rather than a control that leads nowhere (A9).
     */
    onOpenLaunchingCommand?: () => void;
    testID?: string;
}>;

/**
 * The duration this record can honestly claim, or `null`.
 *
 * A finished task needs both instants; a running one needs only a start, and the row above is
 * already showing its live clock, so the detail states a total only once there is one.
 */
function resolveCompletedDurationMs(record: SessionBackgroundTaskRecordV1): number | null {
    const { endedAt, startedAt } = record;
    if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return null;
    const elapsed = endedAt - startedAt;
    return elapsed > 0 ? elapsed : null;
}

export const BackgroundTaskDetail = React.memo<BackgroundTaskDetailProps>((props) => {
    const { theme } = useUnistyles();
    const { record } = props;
    const durationMs = resolveCompletedDurationMs(record);
    const testID = props.testID;

    return (
        <View style={styles.container} testID={testID}>
            {record.label ? (
                <Text
                    style={[styles.body, styles.mono]}
                    testID={testID ? `${testID}:label` : undefined}
                >
                    {record.label}
                </Text>
            ) : null}
            <Text style={styles.meta} testID={testID ? `${testID}:status` : undefined}>
                {durationMs === null
                    ? resolveAgentActivityStatusWord(record.status)
                    : t('session.agentActivity.backgroundTask.statusWithDuration', {
                        status: resolveAgentActivityStatusWord(record.status),
                        duration: formatElapsedDuration(durationMs),
                    })}
            </Text>
            {record.summary ? (
                <Text style={styles.body} testID={testID ? `${testID}:summary` : undefined}>
                    {record.summary}
                </Text>
            ) : null}
            {props.onOpenLaunchingCommand ? (
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('session.agentActivity.backgroundTask.openCommand')}
                    onPress={props.onOpenLaunchingCommand}
                    hitSlop={8}
                    style={styles.link}
                    testID={testID ? `${testID}:open-command` : undefined}
                >
                    <Icon name="arrow-square-out" size={14} color={theme.colors.text.link} />
                    <Text style={styles.linkText}>
                        {t('session.agentActivity.backgroundTask.openCommand')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});
BackgroundTaskDetail.displayName = 'BackgroundTaskDetail';

const styles = StyleSheet.create((theme) => ({
    container: {
        marginLeft: AGENT_ROW_DETAIL_INSET_PX,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        gap: 6,
    },
    body: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    mono: {
        fontFamily: 'monospace',
    },
    meta: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    link: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        minHeight: 28,
    },
    linkText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.link,
    },
}));
