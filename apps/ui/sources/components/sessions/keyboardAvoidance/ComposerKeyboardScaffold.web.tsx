import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.web';

function normalizeScaffoldHeight(height: number): number | undefined {
    if (!Number.isFinite(height) || height <= 0) return undefined;
    return Math.round(height);
}

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const [availablePanelMaxHeight, setAvailablePanelMaxHeight] = React.useState<number | undefined>(undefined);
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const modalKeyboardLiftSuppressed = (modal as Readonly<{ isKeyboardLiftSuppressedByModal?: boolean }> | null | undefined)
        ?.isKeyboardLiftSuppressedByModal === true;
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modalKeyboardLiftSuppressed);
    const layout = useComposerKeyboardLayout({
        availablePanelMaxHeight,
        headerHeight: props.headerHeight,
        keyboardLiftSuppressed,
        layoutBottomInset: props.layoutBottomInset,
        safeAreaBottom: props.safeAreaBottom,
    });
    const handleScaffoldLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = normalizeScaffoldHeight(event.nativeEvent.layout.height);
        setAvailablePanelMaxHeight((current) => (current === nextHeight ? current : nextHeight));
    }, []);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
    }, [layout]);
    const liftPaddingStyle = useAnimatedStyle(() => ({
        paddingBottom: Math.max(0, layout.bottomInset.value - (props.safeAreaBottom ?? 0)),
    }));

    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};

    return (
        <ComposerKeyboardProvider layout={layout}>
            <Animated.View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                testID={props.testID}
                onLayout={handleScaffoldLayout}
                style={[
                    { flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base },
                    liftPaddingStyle,
                    props.style,
                ]}
            >
                <View
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </View>
                <View
                    testID={props.composerTestID}
                    onLayout={handleComposerLayout}
                    style={{ backgroundColor: theme.colors.surface.base }}
                >
                    {props.composer}
                </View>
            </Animated.View>
        </ComposerKeyboardProvider>
    );
}
