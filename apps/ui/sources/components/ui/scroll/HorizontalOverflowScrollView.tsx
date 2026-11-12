import * as React from 'react';
import {
    Platform,
    ScrollView,
    type ScrollViewProps,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { ScrollView as GestureHandlerScrollView } from 'react-native-gesture-handler';
import { requireNativeViewManager } from 'expo-modules-core';

import { NativeTextSelectionSuppressionScope } from '@/components/ui/text/nativeTextSelection';

type HorizontalOverflowScrollViewProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    showsHorizontalScrollIndicator?: boolean;
    /**
     * Keep native text selection on Android. Only for content with no other copy affordance, since
     * selection there competes with the horizontal drag (see below).
     */
    keepNativeTextSelection?: boolean;
    onScroll?: ScrollViewProps['onScroll'];
}>;

type NativeHorizontalOverflowContainerProps = Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

const NativeHorizontalOverflowContainer = Platform.OS === 'android'
    ? requireNativeViewManager<NativeHorizontalOverflowContainerProps>('HappierHorizontalOverflowContainer')
    : null;

// Fills a container sized by its own style (flex parents) and otherwise sizes the container to the
// content; `flex: 1` would collapse to zero height inside an auto-height container.
const NATIVE_CONTAINER_CHILD_STYLE: ViewStyle = { flexGrow: 1, flexShrink: 1, alignSelf: 'stretch' };

export const HorizontalOverflowScrollView = React.memo<HorizontalOverflowScrollViewProps>((props) => {
    const sharedProps: ScrollViewProps = {
        testID: props.testID,
        horizontal: true,
        nestedScrollEnabled: true,
        showsHorizontalScrollIndicator: props.showsHorizontalScrollIndicator,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        ...(props.onScroll ? { onScroll: props.onScroll, scrollEventThrottle: 16 } : {}),
        // Android: a selectable TextView competes with the horizontal drag. A hesitant drag becomes a
        // long press that starts selection and shows the system magnifier mid-scroll.
        children: (
            <NativeTextSelectionSuppressionScope
                suppressed={Platform.OS === 'android' && props.keepNativeTextSelection !== true}
            >
                {props.children}
            </NativeTextSelectionSuppressionScope>
        ),
    };

    // Android: the transcript list is a native scroll container, so the platform ScrollView joins
    // Android nested scrolling directly. A gesture-handler ScrollView here arbitrates against the
    // native list separately and makes horizontal drags stall.
    if (Platform.OS === 'android') {
        const NativeContainer = NativeHorizontalOverflowContainer;
        if (NativeContainer) {
            return (
                <NativeContainer style={props.style}>
                    <ScrollView {...sharedProps} style={NATIVE_CONTAINER_CHILD_STYLE} />
                </NativeContainer>
            );
        }
    }

    if (Platform.OS === 'web') {
        return <ScrollView {...sharedProps} />;
    }

    if (Platform.OS === 'android') return <ScrollView {...sharedProps} />;

    return (
        <GestureHandlerScrollView
            {...sharedProps}
            disallowInterruption={true}
        />
    );
});
