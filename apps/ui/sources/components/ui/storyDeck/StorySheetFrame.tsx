import * as React from 'react';
import { useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { shadowLevelStyle } from '@/shadowElevation';

import { resolveStoryDeckPresentation } from './storyDeckPresentation';

const PHONE_SHEET_MAX_RATIO = 0.85;
const PHONE_BREAKPOINT = 480;

const DRAG_DISMISS_FRACTION = 0.3;
const DRAG_VELOCITY_THRESHOLD = 800;
const SHEET_SLIDE_IN_DURATION_MS = 280;
const SHEET_SLIDE_OUT_DURATION_MS = 240;

export type StorySheetFrameProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    /**
     * Optional dismiss callback wired into the drag-to-dismiss gesture (phone-width sheets).
     * If omitted, the sheet still animates in but cannot be dragged closed; callers should
     * provide their own external dismiss path (e.g. through the modal system).
     */
    onDismiss?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    backdropPhone: {
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    backdropCentered: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sheetPhone: {
        width: '100%',
        backgroundColor: theme.colors.surface.base,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        overflow: 'hidden',
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    sheetCentered: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: theme.borderRadius.modalCard,
        overflow: 'hidden',
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
}));

/**
 * Cross-platform sheet/card chrome for StoryDeck.
 *
 * Phone-width screens:
 *   - Bottom-anchored sheet, rounded top corners.
 *   - Drag-to-dismiss via Reanimated+gesture-handler:
 *       - downward pan tracks the finger
 *       - release below 30% of sheet height OR with downward velocity > 800 → dismiss
 *       - otherwise springs back to rest
 *   - Reduced motion: instant transitions, gesture still works but without animation.
 *
 * Tablet/desktop/wide web:
 *   - Centered modal card with bounded width/height. No drag.
 */
export function StorySheetFrame(props: StorySheetFrameProps) {
    useUnistyles();
    const styles = stylesheet;
    const { width, height } = useWindowDimensions();
    const insets = useChromeSafeAreaInsets();
    const reducedMotion = useReducedMotionPreference();

    const isPhoneSheet = width <= PHONE_BREAKPOINT;
    const presentation = resolveStoryDeckPresentation(width);
    const canDragDismiss = isPhoneSheet;
    const sheetMaxHeight = isPhoneSheet
        ? Math.max(0, height * PHONE_SHEET_MAX_RATIO)
        : Math.min(presentation.frameMaxHeight, height * 0.85);
    const sheetWidth = isPhoneSheet
        ? width
        : Math.min(width - 32, presentation.frameMaxWidth);

    const containerStyle = isPhoneSheet ? styles.backdropPhone : styles.backdropCentered;

    // Slide-in offset (px) from the bottom. Used only when the surface is a sheet.
    const offsetY = useSharedValue(isPhoneSheet && !reducedMotion ? sheetMaxHeight : 0);

    React.useEffect(() => {
        if (!isPhoneSheet) return;
        if (reducedMotion) {
            offsetY.value = 0;
            return;
        }
        offsetY.value = withTiming(0, {
            duration: SHEET_SLIDE_IN_DURATION_MS,
            easing: Easing.bezier(0.2, 0, 0, 1),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPhoneSheet, reducedMotion]);

    const handleDismiss = React.useCallback(() => {
        props.onDismiss?.();
    }, [props.onDismiss]);

    const panGesture = React.useMemo(() => {
        return Gesture.Pan()
            .enabled(canDragDismiss && props.onDismiss != null)
            .activeOffsetY([6, 1024])
            .failOffsetX([-12, 12])
            .onUpdate((event) => {
                'worklet';
                offsetY.value = Math.max(0, event.translationY);
            })
            .onEnd((event) => {
                'worklet';
                const passedDistance = event.translationY > sheetMaxHeight * DRAG_DISMISS_FRACTION;
                const passedVelocity = event.velocityY > DRAG_VELOCITY_THRESHOLD;
                if (passedDistance || passedVelocity) {
                    offsetY.value = withTiming(
                        sheetMaxHeight,
                        { duration: SHEET_SLIDE_OUT_DURATION_MS, easing: Easing.bezier(0.4, 0, 1, 1) },
                        (finished) => {
                            if (finished) {
                                runOnJS(handleDismiss)();
                            }
                        },
                    );
                } else {
                    offsetY.value = withTiming(0, {
                        duration: 220,
                        easing: Easing.bezier(0.2, 0, 0, 1),
                    });
                }
            });
    }, [canDragDismiss, handleDismiss, props.onDismiss, sheetMaxHeight]);

    const animatedSheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: offsetY.value }],
    }));

    const sheetContent = (
        <Animated.View
            style={[
                isPhoneSheet ? styles.sheetPhone : styles.sheetCentered,
                { width: sheetWidth, maxHeight: sheetMaxHeight },
                isPhoneSheet ? animatedSheetStyle : null,
                props.style,
            ]}
        >
            {props.children}
        </Animated.View>
    );

    const sheet = isPhoneSheet ? (
        <GestureDetector gesture={panGesture}>
            {sheetContent}
        </GestureDetector>
    ) : sheetContent;

    return (
        <View
            style={[
                containerStyle,
                isPhoneSheet ? { width, height } : null,
                { paddingBottom: isPhoneSheet ? insets.bottom : 0 },
            ]}
            testID={props.testID}
            pointerEvents="box-none"
        >
            {sheet}
        </View>
    );
}

export type StorySheetFrameImperativeApi = Readonly<{
    close: () => void;
}>;
