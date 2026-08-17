import * as React from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { useComposerKeyboardLayout } from './ComposerKeyboardContext';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

function normalizeInsetHeight(height: number): number {
    'worklet';
    return typeof height === 'number' && Number.isFinite(height)
        ? Math.max(0, height)
        : 0;
}

function resolveNativeCurrentInsetHeight(layout: ComposerKeyboardLayout): number {
    return normalizeInsetHeight(
        layout.composerHeight.value
        + Math.max(layout.keyboardHeightForInset.value, layout.bottomInset.value),
    );
}

function resolveCurrentInsetHeight(layout: ComposerKeyboardLayout | null): number {
    if (!layout) return 0;
    if (Platform.OS === 'web') {
        return normalizeInsetHeight(layout.listBottomInset.value);
    }
    return resolveNativeCurrentInsetHeight(layout);
}

export function ComposerKeyboardScrollInset(props: Readonly<{
    onHeightChange?: (height: number) => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement | null {
    const layout = useComposerKeyboardLayout();
    const lastReportedHeightRef = React.useRef<number | null>(null);
    const reportHeight = React.useCallback((nextHeight: number) => {
        const normalizedHeight = normalizeInsetHeight(nextHeight);
        if (lastReportedHeightRef.current !== normalizedHeight) {
            lastReportedHeightRef.current = normalizedHeight;
            props.onHeightChange?.(normalizedHeight);
        }
    }, [props.onHeightChange]);

    React.useEffect(() => {
        if (!layout) {
            reportHeight(0);
            return undefined;
        }
        const subscribeListBottomInset = layout.subscribeListBottomInset;
        if (!subscribeListBottomInset) {
            reportHeight(resolveCurrentInsetHeight(layout));
            return undefined;
        }

        let replayedNotifiedInset = false;
        const unsubscribe = subscribeListBottomInset((nextHeight) => {
            replayedNotifiedInset = true;
            reportHeight(nextHeight);
        });
        if (!replayedNotifiedInset) {
            reportHeight(resolveCurrentInsetHeight(layout));
        }
        return unsubscribe;
    }, [layout, reportHeight]);

    // `listBottomInset` is the layout owner's continuously updated shared value. Native keyboard
    // frame worklets and the web layout owner both write it, so the spacer keeps moving even when
    // the JS notification subscriber is busy. Do not re-derive this value here: that would create
    // a second geometry owner and could drift from interactive-dismiss and safe-area rules.
    const animatedInsetStyle = useAnimatedStyle(() => ({
        height: normalizeInsetHeight(layout ? layout.listBottomInset.value : 0),
    }), [layout]);

    if (!layout) {
        return null;
    }

    return (
        <Animated.View
            pointerEvents="none"
            testID={props.testID}
            style={[props.style, animatedInsetStyle]}
        />
    );
}
