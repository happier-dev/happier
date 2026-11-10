import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useOptionalModal } from '@/modal';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useReportSessionCockpitComposerChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { ComposerKeyboardProvider } from './ComposerKeyboardContext';
import type { ComposerKeyboardScaffoldProps } from './ComposerKeyboardScaffoldTypes';
import { useComposerKeyboardLayout } from './useComposerKeyboardLayout.native';
import { PaneMainBody } from '@/components/ui/panels/paneMainComposerAnchor';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';

export function ComposerKeyboardScaffold(props: ComposerKeyboardScaffoldProps): React.ReactElement {
    const rootPointer = resolveOverlayPointerEvents(props.pointerEvents ?? 'auto');
    const composerPointer = resolveOverlayPointerEvents(props.composerPointerEvents ?? 'auto');
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const modal = useOptionalModal();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const modalKeyboardLiftSuppressed = modal?.isKeyboardLiftSuppressedByModal === true;
    const keyboardLiftSuppressed = props.keyboardLiftSuppressed === true
        || (!isInsideModalBoundary && modalKeyboardLiftSuppressed);
    // The composer is seated at this root's bottom, so the panel's room ends at the root's top in the window: a
    // Session's own header and page tabs stand above it under no stack header, and a cap from `headerHeight`
    // alone let an expanded composer run up over them (owner 2026-11-10). The root's top does not move with the
    // keyboard (the composer lifts by transform), so one read per layout serves.
    const rootRef = React.useRef<View | null>(null);
    const [rootTopInWindow, setRootTopInWindow] = React.useState(0);
    const handleRootLayout = React.useCallback(() => {
        rootRef.current?.measureInWindow?.((_x, y) => {
            const next = Number.isFinite(y) ? Math.max(0, Math.round(y)) : 0;
            setRootTopInWindow((current) => (Math.abs(current - next) > 1 ? next : current));
        });
    }, []);
    const layout = useComposerKeyboardLayout({
        headerHeight: Math.max(props.headerHeight ?? 0, rootTopInWindow),
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
    // A transparent scaffold is presented over the screen behind it, so it paints no ground of its
    // own and lets the caller supply a `backdrop` instead.
    const surfaceBackgroundColor = props.surface === 'transparent' ? undefined : materialColor(theme.colors.surface.base, 'transparent');

    return (
        <ComposerKeyboardProvider layout={layout}>
            <View
                ref={rootRef}
                onLayout={handleRootLayout}
                accessibilityLabel={props.accessibilityLabel}
                accessibilityRole={props.accessibilityRole}
                pointerEvents={rootPointer.nativePointerEvents}
                testID={props.testID}
                style={[{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: surfaceBackgroundColor }, props.style, rootPointer.webStyle]}
            >
                <PaneMainBody
                    {...contentProps}
                    testID={props.contentTestID}
                    style={[{ flex: 1, minHeight: 0, minWidth: 0 }, contentPropsStyle, props.contentStyle]}
                >
                    {props.children}
                </PaneMainBody>
                <Animated.View
                    pointerEvents={composerPointer.nativePointerEvents}
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
                        composerPointer.webStyle,
                    ]}
                >
                    {props.composer}
                </Animated.View>
            </View>
        </ComposerKeyboardProvider>
    );
}
