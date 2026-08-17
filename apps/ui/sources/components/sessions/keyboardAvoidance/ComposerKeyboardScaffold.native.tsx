import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useReportSessionCockpitComposerChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.native';

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const modalKeyboardLiftSuppressed = (modal as Readonly<{ isKeyboardLiftSuppressedByModal?: boolean }> | null | undefined)
        ?.isKeyboardLiftSuppressedByModal === true;
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modalKeyboardLiftSuppressed);
    const layout = useComposerKeyboardLayout({
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    const composerAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -layout.bottomInset.value }],
    }), [layout]);
    // The composer floats above the bottom chrome, so it is an obstacle for app-shell overlays that
    // sit outside the session screen (the Voice orb). Publish it there; a modal-hosted composer is
    // already covered by its modal and stays out of the shell's obstacle set.
    const reportComposerChromeHeight = useReportSessionCockpitComposerChromeHeight(!isInsideModalBoundary);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
        reportComposerChromeHeight(event.nativeEvent.layout.height);
    }, [layout, reportComposerChromeHeight]);

    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};

    return (
        <ComposerKeyboardProvider layout={layout}>
            <View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                testID={props.testID}
                style={[{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }, props.style]}
            >
                <View
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flex: 1, minHeight: 0, minWidth: 0 }, contentPropsStyle, props.contentStyle]}
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
                            backgroundColor: theme.colors.surface.base,
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
