import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { resolveElapsedTickCadence } from '@/components/ui/motion/reducedMotionTable';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useNowMs } from '@/hooks/time/useNowMs';
import { t } from '@/text';

import { formatElapsedDuration } from '../presentation/formatElapsedDuration';
import { AGENT_TIME_SLOT_MIN_PX } from './agentRowMetrics';

/**
 * The right-aligned elapsed column.
 *
 * Two facts about where this component sits decide its whole design:
 *
 * 1. **The clock subscription lives HERE, below the memoized row.** A ticking value in the row
 *    would re-render every row in the roster once a second, and interpolating it into the row's own
 *    `accessibilityLabel` would additionally make VoiceOver re-announce the focused row at the same
 *    rate. Keeping the subscription in the leaf means a tick re-renders one small text node.
 * 2. **A terminal entry does not subscribe at all.** `endedAtMs` is what stops the clock, and it
 *    stops it by choosing a component that never calls the hook — not by ignoring its value. A
 *    FINISHED section of 24 rows therefore costs zero clock subscribers.
 *
 * The cadence is not decided here either: `resolveElapsedTickCadence()` hands the shared clock both
 * intervals, and the clock applies the reduced-motion one. The elapsed tick is the program's one
 * *essential* motion exception (4.8) — with the spinner substituted out under reduced motion, an
 * advancing number is the only remaining evidence that a running agent is running — so it is slowed
 * to a minute rather than stopped, and paid for by the clock's own pause gates.
 */

export type AgentActivityTimeSlotProps = Readonly<{
    /** Epoch ms. Absent means no elapsed time is knowable, so the column renders nothing. */
    startedAtMs?: number | null;
    /** Epoch ms. Present means the work is over and the value is a fixed total. */
    endedAtMs?: number | null;
    /**
     * Epoch ms at which a still-running entry stops counting because it has gone silent (4.10).
     *
     * The clock clamps itself to this rather than being told "you are stale now": the note that
     * says so is recomputed every 30 s, and a clock that waited for it would count past the
     * threshold and then jump backwards.
     */
    freezeAtMs?: number | null;
    testID?: string;
}>;

export function AgentActivityTimeSlot(props: AgentActivityTimeSlotProps) {
    const startedAtMs = readTimestamp(props.startedAtMs);
    if (startedAtMs == null) return null;

    const endedAtMs = readTimestamp(props.endedAtMs);
    if (endedAtMs != null) {
        const total = formatElapsedDuration(endedAtMs - startedAtMs);
        return (
            <ElapsedText
                testID={props.testID}
                value={total}
                accessibilityLabel={t('session.agentActivity.time.totalA11y', { duration: total })}
            />
        );
    }

    return (
        <LiveElapsedText
            testID={props.testID}
            startedAtMs={startedAtMs}
            freezeAtMs={readTimestamp(props.freezeAtMs)}
        />
    );
}

function LiveElapsedText(props: Readonly<{
    startedAtMs: number;
    freezeAtMs: number | null;
    testID?: string;
}>) {
    const cadence = resolveElapsedTickCadence();
    const nowMs = useNowMs(cadence.intervalMs, {
        reducedMotionIntervalMs: cadence.reducedMotionIntervalMs,
    });

    const { freezeAtMs } = props;
    const frozen = freezeAtMs != null && nowMs >= freezeAtMs;
    const elapsed = formatElapsedDuration((frozen ? freezeAtMs : nowMs) - props.startedAtMs);

    return (
        <ElapsedText
            testID={props.testID}
            value={elapsed}
            // A frozen value announced as "Running for 10:00" would be the clock lying with its
            // own label. The number stays; the claim about it changes.
            accessibilityLabel={frozen
                ? t('session.agentActivity.time.staleA11y', { duration: elapsed })
                : t('session.agentActivity.time.elapsedA11y', { duration: elapsed })}
        />
    );
}

function ElapsedText(props: Readonly<{ value: string; accessibilityLabel: string; testID?: string }>) {
    return (
        <Text
            testID={props.testID}
            style={styles.elapsed}
            numberOfLines={1}
            accessibilityLabel={props.accessibilityLabel}
            // Not a live region: the value changes once a second, and an assistive technology that
            // announced every change would talk over the row the user is actually reading.
            accessibilityLiveRegion="none"
        >
            {props.value}
        </Text>
    );
}

function readTimestamp(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const styles = StyleSheet.create((theme) => ({
    elapsed: {
        ...Typography.timestamp(),
        minWidth: AGENT_TIME_SLOT_MIN_PX,
        textAlign: 'right',
        // Secondary, never tertiary: how long an agent has been waiting for you carries meaning, and
        // `text.tertiary` measures 2.84:1.
        color: theme.colors.text.secondary,
    },
}));
