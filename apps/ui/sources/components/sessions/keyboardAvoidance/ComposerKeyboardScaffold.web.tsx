import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useReportSessionCockpitComposerChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.web';

function normalizeScaffoldHeight(height: number): number | undefined {
    if (!Number.isFinite(height) || height <= 0) return undefined;
    return Math.round(height);
}

function flattenStyleItems(style: StyleProp<ViewStyle>): Array<StyleProp<ViewStyle>> {
    if (Array.isArray(style)) {
        return style.flatMap((item) => flattenStyleItems(item as StyleProp<ViewStyle>));
    }
    return style ? [style] : [];
}

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const { theme } = useUnistyles();
    const [availablePanelMaxHeight, setAvailablePanelMaxHeight] = React.useState<number | undefined>(undefined);
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const modalKeyboardLiftSuppressed = modal?.isKeyboardLiftSuppressedByModal === true;
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
    // The composer floats above the bottom chrome, so it is an obstacle for app-shell overlays that
    // sit outside the session screen (the Voice orb). Publish it there; a modal-hosted composer is
    // already covered by its modal and stays out of the shell's obstacle set.
    const reportComposerChromeHeight = useReportSessionCockpitComposerChromeHeight(!isInsideModalBoundary);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
        reportComposerChromeHeight(event.nativeEvent.layout.height);
    }, [layout, reportComposerChromeHeight]);
    const liftPaddingStyle = useAnimatedStyle(() => ({
        paddingBottom: Math.max(0, layout.bottomInset.value - (props.safeAreaBottom ?? 0)),
    }));

    const { style: contentPropsStyle, ...contentProps } = props.contentProps ?? {};
    // Same contract as the native scaffold: a transparent scaffold paints no ground of its own and
    // lets the caller supply a `backdrop` sibling instead. The prop is declared on the shared type,
    // so honouring it on both implementations keeps it from becoming a native-only promise.
    const surfaceBackgroundColor = props.surface === 'transparent' ? undefined : theme.colors.surface.base;

    return (
        <ComposerKeyboardProvider layout={layout}>
            <Animated.View
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                testID={props.testID}
                onLayout={handleScaffoldLayout}
                style={[
                    { flexBasis: 0, flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: surfaceBackgroundColor },
                    liftPaddingStyle,
                    ...flattenStyleItems(props.style),
                ]}
            >
                {/* Sibling of the content, never a wrapper — see the native scaffold. */}
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
                    style={{ backgroundColor: surfaceBackgroundColor }}
                >
                    {props.composer}
                </View>
            </Animated.View>
        </ComposerKeyboardProvider>
    );
}
