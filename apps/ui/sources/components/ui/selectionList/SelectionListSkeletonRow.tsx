import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
    cancelAnimation,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { SELECTION_LIST_SKELETON_ROW_HEIGHT_PX } from './_constants';

/**
 * R6 — Premium UI design polish (Fix 5): polished shimmer placeholder for
 * dynamic-section loading rows. Replaces the static low-opacity bar that R1
 * shipped. Pulses opacity 0.4 ↔ 0.8 over 800ms in a yoyo loop. Reduced-motion
 * preference snaps to a single static low opacity (0.4) to honor the OS
 * setting.
 *
 * Width varies per row (50% / 80% / 65% cycle) so consecutive rows feel like
 * real content with different label lengths instead of a uniform bar.
 *
 * The component is intentionally tiny: it owns only the visual shimmer. The
 * outer container is hidden from assistive tech on every platform via the
 * R16d trio (`aria-hidden` for web, `accessibilityElementsHidden` for iOS,
 * `importantForAccessibility="no-hide-descendants"` for Android) so assistive
 * tech doesn't announce skeleton chrome.
 */

const SKELETON_HEIGHT_PX = 16;
const SKELETON_HORIZONTAL_MARGIN_PX = 16;
const SKELETON_BORDER_RADIUS_PX = 6;
const SHIMMER_DURATION_MS = 800;
const SHIMMER_OPACITY_LOW = 0.4;
const SHIMMER_OPACITY_HIGH = 0.8;
const SKELETON_WIDTH_PERCENTAGES: ReadonlyArray<number> = [50, 80, 65, 72, 58];

const stylesheet = StyleSheet.create((theme) => ({
    // R13 (Fix 5): the OUTER container reserves the same vertical footprint
    // the rendered option row will eventually use. Without this, loading→ready
    // shifts the popover layout downwards by the (rowHeight - shimmerHeight)
    // delta. The shimmer bar centers within the reserved height.
    container: {
        height: SELECTION_LIST_SKELETON_ROW_HEIGHT_PX,
        justifyContent: 'center',
    },
    row: {
        height: SKELETON_HEIGHT_PX,
        marginHorizontal: SKELETON_HORIZONTAL_MARGIN_PX,
        borderRadius: SKELETON_BORDER_RADIUS_PX,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));

export type SelectionListSkeletonRowProps = Readonly<{
    /** Row index — drives the cycling width pattern so rows feel natural. */
    index: number;
    testID?: string;
}>;

export function SelectionListSkeletonRow(
    props: SelectionListSkeletonRowProps,
): React.ReactElement {
    const styles = stylesheet;
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

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
    }));

    const widthPercent = SKELETON_WIDTH_PERCENTAGES[
        props.index % SKELETON_WIDTH_PERCENTAGES.length
    ] ?? 70;
    const widthStyle = { width: `${widthPercent}%` as const };

    // R13 (Fix 5): outer container reserves the full row geometry (height) so
    // the popover does NOT shift when loading→ready. The inner Animated.View
    // is the visible shimmer bar (16px) centered vertically inside.
    return (
        <View
            testID={props.testID}
            style={styles.container}
            // R16d (Fix 2): hide the loading skeleton from assistive tech on
            // every platform. Web honors `aria-hidden`; iOS reads
            // `accessibilityElementsHidden`; Android reads
            // `importantForAccessibility="no-hide-descendants"`. RN silently
            // ignores unknown props per platform, so passing all three keeps
            // the cross-platform contract explicit.
            aria-hidden={true}
            accessibilityElementsHidden={true}
            importantForAccessibility="no-hide-descendants"
        >
            <Animated.View
                testID={props.testID ? `${props.testID}:bar` : undefined}
                style={[styles.row, widthStyle, animatedStyle]}
            />
        </View>
    );
}
