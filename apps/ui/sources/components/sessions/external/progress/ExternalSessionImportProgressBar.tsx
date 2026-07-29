import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ShimmerView } from '@/components/ui/feedback/ShimmerView';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export const ExternalSessionImportProgressBar = React.memo(function ExternalSessionImportProgressBar(props: Readonly<{
    importedItemCount: number;
    totalItemEstimate: number | null;
    ratio: number | null;
    accessibilityLabel: string;
}>) {
    const reducedMotion = useReducedMotionPreference();
    const initialRatio = props.ratio === null ? 0 : Math.max(0, Math.min(1, props.ratio));
    const greatestRatioRef = React.useRef(initialRatio);
    const animatedRatio = React.useRef(new Animated.Value(initialRatio)).current;

    React.useEffect(() => {
        if (props.ratio === null) return;
        const target = Math.max(
            greatestRatioRef.current,
            Math.max(0, Math.min(1, props.ratio)),
        );
        greatestRatioRef.current = target;
        if (reducedMotion) {
            animatedRatio.setValue(target);
            return;
        }
        const animation = Animated.timing(animatedRatio, {
            toValue: target,
            duration: 200,
            useNativeDriver: false,
        });
        animation.start();
        return () => animation.stop();
    }, [animatedRatio, props.ratio, reducedMotion]);

    const accessibilityValue = props.totalItemEstimate !== null && props.totalItemEstimate > 0
        ? {
            min: 0,
            max: props.totalItemEstimate,
            now: Math.min(props.importedItemCount, props.totalItemEstimate),
        }
        : undefined;

    if (props.ratio === null) {
        return (
            <View
                testID="external-session-operation-progress-indeterminate"
                style={styles.track}
                accessibilityRole="progressbar"
                accessibilityLabel={props.accessibilityLabel}
            >
                <ShimmerView animationEnabled={!reducedMotion} style={styles.indeterminateWindow}>
                    <View style={styles.indeterminateFill} />
                </ShimmerView>
            </View>
        );
    }

    return (
        <View
            testID="external-session-operation-progress-determinate"
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityValue={accessibilityValue}
        >
            <Animated.View
                style={[
                    styles.determinateFill,
                    {
                        width: animatedRatio.interpolate({
                            inputRange: [0, 1],
                            outputRange: ['0%', '100%'],
                        }),
                    },
                ]}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    track: {
        width: 112,
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.inset,
    },
    determinateFill: {
        height: '100%',
        borderRadius: 3,
        backgroundColor: theme.colors.accent.blue,
    },
    indeterminateWindow: {
        width: '100%',
        height: '100%',
    },
    indeterminateFill: {
        width: '45%',
        height: '100%',
        borderRadius: 3,
        backgroundColor: theme.colors.accent.blue,
    },
}));
