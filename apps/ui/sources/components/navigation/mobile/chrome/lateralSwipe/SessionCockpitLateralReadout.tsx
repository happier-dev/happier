import * as React from 'react';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSessionLateralSwipe } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import { resolveSessionLateralSwipeReadoutOpacity } from './sessionLateralSwipeMotion';
import { useSessionLateralPickerSelection } from './useSessionLateralPickerSelection';

/**
 * The capsule's readout while a lateral swipe is under the finger.
 *
 * The feature has no permanent affordance, so the capsule itself becomes the
 * affordance: the tab row dims and this readout names where the finger is heading.
 * It is absolutely positioned over the row on purpose — the capsule keeps its
 * tab-derived width for the whole gesture, because a capsule that resized mid-drag
 * would read as broken rather than as direct manipulation.
 *
 * At rest it paints nothing (opacity 0, `pointerEvents: none`): the bar is exactly
 * what it was before this feature existed.
 *
 * It names whatever the gesture has SELECTED — the immediate neighbour while the finger
 * is only travelling sideways, and the scrubbed row once the picker above is open. Both
 * come from the one selection bridge the picker's own rows read, so the row descending
 * into this capsule and the capsule itself can never name two different sessions.
 */

const styles = StyleSheet.create((theme) => ({
    root: {
        // Absolute on purpose: the capsule keeps its tab-derived width for the whole
        // gesture. A capsule that resized under the finger is the one thing that would
        // make this read as broken rather than as direct manipulation.
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 14,
    },
    title: {
        flexShrink: 1,
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    position: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        ...Typography.tabular(),
    },
}));

export type SessionCockpitLateralReadoutProps = Readonly<{
    sessionId: string;
    /**
     * Same server scope the picker column resolves under. Without it the capsule would
     * anchor by bare session id while the column above anchors by scoped key, and the
     * row descending into the capsule could name a different session than the capsule —
     * the one thing "the two surfaces are one object" forbids.
     */
    serverId?: string | null;
}>;

export const SessionCockpitLateralReadout = React.memo(function SessionCockpitLateralReadout(
    props: SessionCockpitLateralReadoutProps,
) {
    const { progress, picker } = useSessionLateralSwipe();
    const { theme } = useUnistyles();
    const target = useSessionLateralPickerSelection({
        sessionId: props.sessionId,
        ...(props.serverId === undefined ? null : { serverId: props.serverId }),
    }).selected;

    const readoutStyle = useAnimatedStyle(
        // The picker floors the fade: once it is open the capsule is its selection
        // window, so the destination must be fully present however short the sideways
        // drag that armed it was.
        () => ({ opacity: resolveSessionLateralSwipeReadoutOpacity(progress.value, picker.browseProgress.value) }),
        [picker, progress],
    );

    if (!target) {
        // Nothing to say: at rest, or the finger is rubber-banding against an end of
        // the order (where there is deliberately no destination to promise).
        return null;
    }

    return (
        <Animated.View pointerEvents="none" style={[styles.root, readoutStyle]} testID="session-cockpit-lateral-readout">
            <SessionAgentCatalogIdentityIcon
                // Unknown identity degrades to the catalog owner's neutral mark;
                // the capsule never borrows a default Agent's brand.
                agentId={target.agentId ?? ''}
                machineId={target.machineId}
                serverId={target.serverId ?? null}
                color={theme.colors.text.primary}
                size={18}
            />
            <Text style={styles.title} numberOfLines={1} testID="session-cockpit-lateral-readout-title">
                {target.title}
            </Text>
            <Text style={styles.position} testID="session-cockpit-lateral-readout-position">
                {t('workspaceCockpit.sessionPosition', { position: target.position, total: target.total })}
            </Text>
        </Animated.View>
    );
});
