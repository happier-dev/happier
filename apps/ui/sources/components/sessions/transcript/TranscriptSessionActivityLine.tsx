import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionElapsedClock } from '@/components/sessions/companion/summary/SessionSummaryStatusLine';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionAwareness } from '@/sync/domains/session/awareness/useSessionAwareness';
import { presentSessionAwarenessV1 } from '@/utils/sessions/sessionUtils';

/**
 * While a hidden-tools turn runs, the one live line that says what the agent is doing (60s4, lab `b-activity`).
 * It exists only while the work-state owner says work is running: a settled turn is the collapsed
 * "Tool calls · N" group, and offline/unknown/needs-you states belong to the composer status row and the
 * request cards, so this line never repeats them.
 *
 * It is quiet transcript furniture, not a heading: the spinner, the awareness owner's words in secondary ink
 * and the turn's elapsed time in tabular figures, announced politely as a status.
 */
const RUNNING_STATES: ReadonlySet<ReturnType<typeof presentSessionAwarenessV1>['state']> = new Set(['thinking', 'background_active']);

/** Compact activity, subscribed below the frozen shell through the shared awareness owner. */
export const TranscriptSessionActivityLine = React.memo(function TranscriptSessionActivityLine(props: Readonly<{
    sessionId: string;
    serverId: string;
}>) {
    const { theme } = useUnistyles();
    const { session, awareness, turnStartedAtMs } = useSessionAwareness(props.sessionId, props.serverId);
    if (!session || !awareness) return null;
    const status = presentSessionAwarenessV1(awareness);
    if (!RUNNING_STATES.has(status.state)) return null;
    return (
        <View
            testID="transcript-session-activity"
            style={stylesheet.row}
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            aria-live="polite"
        >
            <ActivitySpinner size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            <Text testID="transcript-session-activity-status" style={stylesheet.words} numberOfLines={1}>
                {status.statusText}
            </Text>
            {turnStartedAtMs !== null ? (
                <>
                    <Text style={stylesheet.separator} aria-hidden>·</Text>
                    <SessionElapsedClock sinceMs={turnStartedAtMs} testID="transcript-session-activity-timer" style={stylesheet.timer} />
                </>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 28,
    },
    words: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    separator: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    // Tabular figures: the clock ticks without moving the words before it.
    timer: {
        ...Typography.default(),
        ...Typography.tabular(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
}));
