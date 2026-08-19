import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { OverlayScrim } from '@/components/ui/overlays/OverlayScrim';
import { Text } from '@/components/ui/text/Text';
import { useSessionLateralSwipe } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import {
    SESSION_LATERAL_PICKER_ROW_PITCH_PX,
    resolveSessionLateralPickerRowMotion,
} from './sessionLateralPickerState';
import { useSessionLateralPickerSelection } from './useSessionLateralPickerSelection';
import type { SessionLateralNavigationTarget } from './useSessionCockpitLateralNavigation';

/**
 * The lateral gesture's second axis, made visible.
 *
 * Once the horizontal has locked a direction, lifting the finger opens this column of the
 * sessions FURTHER that way, and scrubbing up and down moves the selection through it.
 * The capsule below is the column's SELECTION WINDOW, not a separate readout that happens
 * to agree: the list slides down one row per selected index, and the row arriving at the
 * window dissolves into it exactly as the capsule starts naming that session. The two
 * surfaces are one object, which is the whole reason this can have no affordance of its
 * own — you already know where the answer appears, because it appears where you were
 * already looking.
 *
 * Scrubbing navigates NOTHING. A session switch remounts a transcript, and this gesture is
 * only affordable because that cost is paid once, at release, for the row you actually
 * chose. Everything here is presentation.
 *
 * AT REST IT PAINTS NOTHING. Like `TreeDropOverlay`, it is always mounted, never
 * interactive, and driven entirely by shared values: React sees the direction lock and the
 * selected row, never a frame of the drag.
 *
 * The rows are a FIXED SET, mounted once when the direction locks and covering the whole
 * reachable depth. They are not a recycling window: recycling would have to re-key a row
 * mid-drag from the JS thread while the worklets are already placing it, and the one frame
 * where those disagree is a row visibly showing the wrong session as it enters the capsule.
 * A dozen absolutely-positioned rows placed by worklets cost nothing per frame; the mount
 * is paid once, off the gesture's own thread.
 *
 * WHY THE SCRIM IS MOUNTED AT FULL SIZE AND ONLY FADED
 *
 * `OverlayScrim` may not animate anything but its wrapper opacity — `expo-blur` allocates
 * a fresh `UIViewPropertyAnimator` per intensity write, `MaskedView` re-rasterises a
 * full-size bitmap per mask invalidation on Android, and `expo-linear-gradient`
 * re-rasterises on every bounds change. So the frost is laid out once, at its final size,
 * and the ONLY thing that moves is `progress`. Growing this overlay by animating its
 * height would re-rasterise three masked layers on every frame of a finger drag.
 *
 * The "dissolving upward" therefore comes from the ROWS, in worklets, where it is free.
 * That is also why the far rows fade themselves out: the frost band reaches 88pt and the
 * column is taller than that, so above the frost a row has to end by dissolving rather
 * than by meeting an edge. On Android the scrim is the dim without the blur, and the
 * design is built to read from the dim alone — the rows' own dissolve is what carries it.
 */

export const SESSION_LATERAL_PICKER_TEST_ID = 'session-cockpit-lateral-picker';
export const SESSION_LATERAL_PICKER_SCRIM_TEST_ID = 'session-cockpit-lateral-picker-scrim';
export const SESSION_LATERAL_PICKER_ROW_TEST_ID = 'session-cockpit-lateral-picker-row';

const styles = StyleSheet.create((theme) => ({
    root: {
        // Matches the band exactly, so the scrim seats itself against the capsule and the
        // column can hang off the band's top edge without measuring anything.
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    column: {
        position: 'absolute',
        left: 0,
        right: 0,
        // The band's top edge. Rows stack upward from here and travel down through it.
        bottom: '100%',
    },
    row: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: SESSION_LATERAL_PICKER_ROW_PITCH_PX,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        // The same 8pt glyph-to-title gap the capsule readout uses, so a row does not
        // change shape as it arrives there.
        gap: 8,
        paddingHorizontal: 24,
    },
    title: {
        flexShrink: 1,
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

export type SessionCockpitLateralPickerProps = Readonly<{
    sessionId: string | null;
    serverId?: string | null;
}>;

export const SessionCockpitLateralPicker = React.memo(function SessionCockpitLateralPicker(
    props: SessionCockpitLateralPickerProps,
) {
    const { picker } = useSessionLateralSwipe();
    const reducedMotion = useReducedMotionPreference();
    const selection = useSessionLateralPickerSelection({
        sessionId: props.sessionId,
        ...(props.serverId === undefined ? null : { serverId: props.serverId }),
    });

    // The nearest session that way is already in the capsule, named by the readout, so
    // the column starts one past it — a second copy of it above the bar would be the same
    // session drawn twice, one of them permanently at zero opacity.
    const rows = selection.targets.slice(1);

    return (
        // Hidden from assistive tech, like every other in-gesture overlay: this surface
        // exists only while a finger is on it, so its rows must never become focus stops.
        // The non-gesture equivalent of the whole feature rides the cockpit tabs as
        // "Previous session" / "Next session" actions, which stay reachable and unchanged.
        <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.root}
            testID={SESSION_LATERAL_PICKER_TEST_ID}
        >
            <OverlayScrim progress={picker.browseProgress} testID={SESSION_LATERAL_PICKER_SCRIM_TEST_ID} />
            <View style={styles.column}>
                {rows.map((target, offset) => (
                    <SessionCockpitLateralPickerRow
                        key={target.sessionId}
                        target={target}
                        entryIndex={offset + 2}
                        reducedMotion={reducedMotion}
                    />
                ))}
            </View>
        </View>
    );
});

const SessionCockpitLateralPickerRow = React.memo(function SessionCockpitLateralPickerRow(props: Readonly<{
    target: SessionLateralNavigationTarget;
    entryIndex: number;
    reducedMotion: boolean;
}>) {
    const { picker } = useSessionLateralSwipe();
    const { entryIndex, reducedMotion } = props;
    const rowStyle = useAnimatedStyle(() => {
        const motion = resolveSessionLateralPickerRowMotion({
            entryIndex,
            rowOffset: picker.rowOffset.value,
            browseProgress: picker.browseProgress.value,
            reducedMotion,
        });
        return {
            opacity: motion.opacity,
            transform: [{ translateY: motion.translateY }],
        };
    }, [entryIndex, picker, reducedMotion]);

    return (
        <Animated.View style={[styles.row, rowStyle]} testID={SESSION_LATERAL_PICKER_ROW_TEST_ID}>
            <AgentIcon agentId={props.target.agentId} size={18} />
            {/* Glyph and title only. The capsule owns the position readout, so a row
                gaining "5 of 18" is what tells you it has arrived. */}
            <Text style={styles.title} numberOfLines={1}>
                {props.target.title}
            </Text>
        </Animated.View>
    );
});
