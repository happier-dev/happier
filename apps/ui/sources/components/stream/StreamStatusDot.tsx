import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { LiveStreamPlayerPhase } from '@/sync/domains/machines/peer/mediation/stream/player';

import { streamPlayerStyles } from './styles';

/**
 * Stream-domain status indicator. Maps a semantic stream `variant` to a themed
 * state token + soft halo and delegates the cross-platform dot (and its pulse)
 * to the canonical `StatusDot` primitive — no duplicated pulse logic lives here.
 *
 * Only the `live` variant pulses, and only when reduced-motion is off, so a
 * stalled / errored / idle stream never reads as a live one. Under the OS
 * reduced-motion preference the dot is static. Colors are Unistyles theme
 * tokens (no raw hex).
 */

export type StreamStatusDotVariant = 'live' | 'stale' | 'error' | 'idle';

type StateTokenKey = 'success' | 'warning' | 'danger' | 'neutral';

const VARIANT_TO_STATE_TOKEN: Readonly<Record<StreamStatusDotVariant, StateTokenKey>> = {
    live: 'success',
    stale: 'warning',
    error: 'danger',
    idle: 'neutral',
};

/**
 * Canonical mapping from a live-stream phase (+ optional reason code) to the
 * status-dot variant. Single owner so the player overlay and the device-preview
 * header share one set of dot semantics (live / stale / error / idle).
 */
export function resolveStreamStatusDotVariant(
    phase: LiveStreamPlayerPhase,
    reasonCode?: string,
): StreamStatusDotVariant {
    if (reasonCode === 'input_lease_expired' || reasonCode === 'permission_expired') return 'error';
    switch (phase) {
        case 'playing':
            return 'live';
        case 'degraded':
        case 'reconnecting':
            return 'stale';
        case 'error':
            return 'error';
        case 'opening':
        case 'stopped':
        case 'idle':
            return 'idle';
    }
}

export function StreamStatusDot(props: Readonly<{
    variant: StreamStatusDotVariant;
    /** Override the OS reduced-motion preference (defaults to the live setting). */
    reducedMotion?: boolean;
    size?: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const systemReducedMotion = useReducedMotionPreference();
    const reducedMotion = props.reducedMotion ?? systemReducedMotion;
    const color = theme.colors.state[VARIANT_TO_STATE_TOKEN[props.variant]].foreground;
    const isPulsing = props.variant === 'live' && !reducedMotion;
    const size = props.size ?? 8;

    return (
        <View
            testID={props.testID}
            accessibilityRole="image"
            style={[streamPlayerStyles.statusDot, props.style]}
        >
            <View
                testID={props.testID ? `${props.testID}:halo` : undefined}
                pointerEvents="none"
                style={[streamPlayerStyles.statusDotHalo, { backgroundColor: color }]}
            />
            <StatusDot
                testID={props.testID ? `${props.testID}:dot` : undefined}
                color={color}
                isPulsing={isPulsing}
                size={size}
            />
        </View>
    );
}
