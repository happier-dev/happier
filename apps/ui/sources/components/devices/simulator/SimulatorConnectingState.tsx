import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { StreamStatusDot } from '@/components/stream/StreamStatusDot';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';

const SHIMMER_DURATION_MS = 800;
const SHIMMER_OPACITY_LOW = 0.4;
const SHIMMER_OPACITY_HIGH = 0.85;

/**
 * Intentional "connecting / restoring" surface for the device-preview pane. It
 * is a DISTINCT surface from the terminal `SimulatorUnavailableState`: a device
 * whose capture is available but whose stream has not produced a renderable
 * frame yet shows this skeleton, never a blank rectangle and never the
 * "unavailable" card.
 *
 * `mode='restoring'` is used when an established stream is re-hydrating
 * (reconnecting) with no preserved frame; `mode='connecting'` is the first-open
 * case. The shimmer honors the OS reduced-motion preference (static under
 * reduced motion), mirroring the canonical skeleton-row pattern.
 */

export function SimulatorConnectingState(props: Readonly<{
    mode: 'connecting' | 'restoring';
    testID: string;
}>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    const opacity = useSharedValue(SHIMMER_OPACITY_LOW);

    React.useEffect(() => {
        if (reducedMotion) {
            opacity.value = SHIMMER_OPACITY_LOW;
            return;
        }
        opacity.value = withRepeat(
            withTiming(SHIMMER_OPACITY_HIGH, { duration: SHIMMER_DURATION_MS }),
            -1,
            true,
        );
        return () => {
            cancelAnimation(opacity);
        };
    }, [opacity, reducedMotion]);

    const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

    const label = props.mode === 'restoring'
        ? t('simulatorPreview.status.restoring')
        : t('simulatorPreview.status.connecting');

    return (
        <View testID={`${props.testID}-connecting`} style={simulatorStreamStyles.connecting}>
            <View style={simulatorStreamStyles.connectingHeader}>
                <StreamStatusDot
                    variant={props.mode === 'restoring' ? 'stale' : 'idle'}
                    testID={`${props.testID}-connecting-dot`}
                />
                <Text style={simulatorStreamStyles.titleText}>{label}</Text>
            </View>
            <Animated.View
                testID={`${props.testID}-connecting-skeleton`}
                style={[simulatorStreamStyles.connectingSkeleton, animatedStyle]}
                aria-hidden={true}
                accessibilityElementsHidden={true}
                importantForAccessibility="no-hide-descendants"
            />
        </View>
    );
}
