import * as React from 'react';
import { Platform, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.native';

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const windowDimensions = useWindowDimensions();
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modal?.isKeyboardLiftSuppressedByModal === true);
    const layout = useComposerKeyboardLayout({
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};
    // A transparent scaffold is presented over the screen behind it, so it paints no ground of
    // its own; whatever it is presented over stays visible.
    const isTransparentSurface = props.surface === 'transparent';
    const surfaceBackgroundColor = isTransparentSurface ? undefined : theme.colors.surface.base;
    const newSessionScaffoldMaxHeight = React.useMemo(() => {
        if (props.mode !== 'newSession') return undefined;
        if (Platform.OS !== 'ios') return undefined;
        // The cap below is window-derived geometry that exists only to survive a cold `pageSheet`
        // presentation. A transparent presentation has no sheet frame and no header, so applying it
        // there would clamp against a header that is not rendered.
        if (isTransparentSurface) return undefined;
        if (typeof props.safeAreaTop !== 'number' || !Number.isFinite(props.safeAreaTop)) return undefined;
        const safeTop = Math.max(0, props.safeAreaTop);
        const headerHeight = typeof props.headerHeight === 'number' && Number.isFinite(props.headerHeight)
            ? Math.max(0, props.headerHeight)
            : 0;
        return Math.max(0, Math.round(windowDimensions.height - safeTop - headerHeight));
    }, [isTransparentSurface, props.headerHeight, props.mode, props.safeAreaTop, windowDimensions.height]);

    // Composer translateY = the keyboard/safe-area inset. The root scaffold inherits the native
    // modal content frame; adding a separate window-derived sheet height can overflow cold modal
    // presentations and push this bottom-anchored composer below the visible screen.
    const composerAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -layout.bottomInset.value }],
    }), [layout]);
    const handleScaffoldLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setScaffoldMeasuredHeight?.(event.nativeEvent.layout.height);
    }, [layout]);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
    }, [layout]);

    return (
        <ComposerKeyboardProvider layout={layout}>
            <View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                onLayout={handleScaffoldLayout}
                testID={props.testID}
                style={[
                    { flex: 1, minHeight: 0, backgroundColor: surfaceBackgroundColor },
                    typeof newSessionScaffoldMaxHeight === 'number' ? { maxHeight: newSessionScaffoldMaxHeight } : null,
                    props.style,
                ]}
            >
                <View
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flex: 1, minHeight: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </View>
                <Animated.View
                    testID={props.composerTestID}
                    onLayout={handleComposerLayout}
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            backgroundColor: surfaceBackgroundColor,
                        },
                        composerAnimatedStyle,
                    ]}
                >
                    {props.composer}
                </Animated.View>
            </View>
        </ComposerKeyboardProvider>
    );
}
