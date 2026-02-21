import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withTiming,
    interpolate,
    Easing,
    useAnimatedRef,
    measure,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

interface ShimmerViewProps {
    children: React.ReactNode;
    shimmerColors?: readonly [string, string, ...string[]];
    shimmerWidthPercent?: number;
    duration?: number;
    style?: ViewStyle;
}

export const ShimmerView = React.memo<ShimmerViewProps>(({
    children,
    shimmerColors,
    shimmerWidthPercent = 80,
    duration = 1500,
    style,
}) => {
    const { theme } = useUnistyles();
    const shimmerTranslate = useSharedValue(0);
    const containerRef = useAnimatedRef<View>();

    const resolvedShimmerColors = React.useMemo<readonly [string, string, ...string[]]>(() => {
        if (shimmerColors && shimmerColors.length >= 2) return shimmerColors as readonly [string, string, ...string[]];
        return [
            theme.colors.surfacePressed,
            theme.colors.surfaceHigh,
            theme.colors.surfaceHighest,
            theme.colors.surfaceHigh,
            theme.colors.surfacePressed,
        ] as const;
    }, [
        shimmerColors,
        theme.colors.surfaceHigh,
        theme.colors.surfaceHighest,
        theme.colors.surfacePressed,
    ]);

    React.useEffect(() => {
        shimmerTranslate.value = withRepeat(
            withTiming(1, {
                duration,
                easing: Easing.linear,
            }),
            -1,
            false
        );
    }, [duration]);

    const animatedStyle = useAnimatedStyle(() => {
        const measured = measure(containerRef);
        const width = measured ? measured.width : 0;
        const shimmerWidth = width * (shimmerWidthPercent / 100);
        const translateX = interpolate(
            shimmerTranslate.value,
            [0, 1],
            [-shimmerWidth, width]
        );
        return {
            transform: [{ translateX }],
        };
    });

    return (
        <Animated.View ref={containerRef} style={style}>
            {/* Render invisible children first to establish size */}
            <View style={styles.hiddenChildren}>
                {children}
            </View>
            
            {/* Shimmer overlay */}
            <MaskedView
                style={StyleSheet.absoluteFillObject}
                maskElement={
                    <View style={styles.maskContainer}>
                        {children}
                    </View>
                }
            >
                {/* Base background */}
                <View style={[StyleSheet.absoluteFillObject, { backgroundColor: resolvedShimmerColors[0] }]} />

                {/* Animated shimmer */}
                <AnimatedLinearGradient
                    colors={resolvedShimmerColors}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={[
                        StyleSheet.absoluteFillObject,
                        animatedStyle,
                    ]}
                />
            </MaskedView>
        </Animated.View>
    );
});

const styles = StyleSheet.create({
    maskContainer: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    hiddenChildren: {
        opacity: 0,
    },
});
