import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { INSTRUMENT_SHIMMER, useMotionPreferences } from '@/components/instrument';

/**
 * Loading state for the usage journey: skeleton blocks with the same shapes as
 * sections 1–3 (filters row, hero card, insight chips, activity block),
 * shimmering while the first response is in flight — never a spinner. The
 * shimmer is a transient loading affordance (not idle animation) and stops
 * with unmount; `minimal`/reduce-motion renders static blocks.
 */

const styles = StyleSheet.create((theme) => ({
    wrap: {
        alignSelf: 'center',
        width: '100%',
        paddingHorizontal: 16,
        paddingTop: 16,
        gap: 16,
    },
    block: {
        borderRadius: 16,
        backgroundColor: theme.colors.surface.inset,
    },
    filters: {
        height: 88,
        borderRadius: 18,
    },
    hero: {
        height: 180,
        borderRadius: 20,
    },
    chipRow: {
        flexDirection: 'row',
        gap: 12,
    },
    chip: {
        flex: 1,
        height: 84,
    },
    activity: {
        height: 220,
        borderRadius: 18,
    },
}));

export const UsageLoadingSkeleton: React.FC<{ testID?: string }> = ({ testID }) => {
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const wrapMaxWidthStyle = useLayoutMaxWidthStyle();
    const motion = useMotionPreferences();
    const shimmer = motion.level !== 'minimal';
    const pulse = useSharedValue(0.55);

    React.useEffect(() => {
        if (!shimmer) return;
        pulse.value = withRepeat(
            withTiming(1, { duration: INSTRUMENT_SHIMMER.periodMs / 2 }),
            -1,
            true,
        );
        return () => {
            cancelAnimation(pulse);
        };
    }, [pulse, shimmer]);

    const shimmerStyle = useAnimatedStyle(() => ({
        opacity: shimmer ? pulse.value : 0.7,
    }));

    return (
        <Animated.View testID={testID ?? 'usage-loading-skeleton'} style={[styles.wrap, wrapMaxWidthStyle, shimmerStyle]}>
            <View style={[styles.block, styles.filters]} />
            <View style={[styles.block, styles.hero]} />
            <View style={styles.chipRow}>
                <View style={[styles.block, styles.chip]} />
                <View style={[styles.block, styles.chip]} />
                <View style={[styles.block, styles.chip]} />
            </View>
            <View style={[styles.block, styles.activity]} />
        </Animated.View>
    );
};
