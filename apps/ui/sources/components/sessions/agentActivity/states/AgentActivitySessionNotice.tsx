import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionWorkObservation } from '@/sync/domains/session/attention/deriveSessionWorkObservation';
import { t, type TranslationKey } from '@/text';

import { AGENT_ACTIVITY_SURFACE_DENSITY } from '../row/agentRowMetrics';

/**
 * What a roster says about the SESSION behind it, once, above the work (RULING-16).
 *
 * **Why a sentence and not a status.** When the session that owned a piece of agent work is gone or
 * unobserved, the honest thing to say is that we stopped watching — not that the agents stopped.
 * Rewriting each row's status would be a durable-looking claim about work this client never
 * observed, and it would silently move rows between sections while it made it. So the rows are left
 * exactly as they were last seen and the uncertainty is stated once, here.
 *
 * **What it does not say.** A usage limit is deliberately absent: the usage-limit banner already
 * owns that copy, its reset time and its recovery action, and a second voice for it is how two
 * surfaces come to disagree about when a session resumes. This component returns `null` for it, and
 * the fact stays classified in `SessionWorkObservation` so the deferral is a decision rather than a
 * gap.
 *
 * It is a quiet line in secondary ink, not a warning card: the surface below it is unchanged and
 * still true as of the last thing we saw, so the reader needs a caveat, not an alarm.
 */

export type AgentActivitySessionNoticeProps = Readonly<{
    observation: SessionWorkObservation;
    /**
     * The host's horizontal correction, exactly as a row receives it.
     *
     * This line carries the row gutter itself, so a host that already pads its content cancels it
     * here the same way it cancels `Item`'s — which is what keeps the sentence on the same edge as
     * the titles below it in a padded host and in an unpadded one.
     */
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

/**
 * The one sentence for an observation, or `null` when this surface has nothing to add.
 *
 * Exported so a host can ask whether a notice exists without rendering one — and so the mapping is
 * a table rather than a chain of conditions spread through a component.
 */
export function resolveAgentActivitySessionNoticeKey(
    observation: SessionWorkObservation,
): TranslationKey | null {
    switch (observation.state) {
        case 'observed':
            return null;
        case 'unobserved':
            return 'session.agentActivity.sessionNotice.unobserved';
        case 'stopped':
            switch (observation.reason) {
                // Actionable, and no other surface in this app has ever interpreted it.
                case 'auth':
                    return 'session.agentActivity.sessionNotice.stoppedAuth';
                // Owned elsewhere, with a reset time and a recovery action this surface has neither.
                case 'usage_limit':
                    return null;
                // Everything else shares one sentence, and `default` rather than an exhaustive table
                // is deliberate: the generic line is TRUE of any stop, so a reason this build
                // predates degrades to a true sentence instead of a wrong one. Only a reason a
                // reader can act on earns its own copy.
                default:
                    return 'session.agentActivity.sessionNotice.stopped';
            }
        default: {
            const exhaustive: never = observation;
            return exhaustive;
        }
    }
}

export function AgentActivitySessionNotice(
    props: AgentActivitySessionNoticeProps,
): React.ReactElement | null {
    const key = resolveAgentActivitySessionNoticeKey(props.observation);
    if (!key) return null;

    return (
        <View style={[styles.container, props.style]} testID={props.testID}>
            <Text style={styles.text}>{t(key)}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        // The row gutter, so the sentence starts on the same edge as the titles beneath it rather
        // than on the surface's own edge.
        paddingHorizontal: ITEM_ROW_PADDING_HORIZONTAL[AGENT_ACTIVITY_SURFACE_DENSITY],
        paddingTop: 8,
        paddingBottom: 4,
    },
    text: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
}));
