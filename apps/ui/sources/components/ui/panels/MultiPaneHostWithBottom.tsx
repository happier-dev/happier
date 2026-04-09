import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { MultiPaneHost, type MultiPaneHostProps } from './MultiPaneHost';
import { ResizableDockedPaneVertical } from './resizable/ResizableDockedPaneVertical';
import { ESCAPE_KEY_BLOCKER_PRIORITIES, markEscapeEventHandled, registerEscapeKeyBlocker } from './escapeKeyHandling';
import { usePaneAnimatedPresence } from './motion/usePaneAnimatedPresence';
import { PaneAnimatedScrimPressable } from './motion/PaneAnimatedScrimPressable';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type BottomPanePresentation = 'docked' | 'overlay';

export type MultiPaneHostWithBottomProps = MultiPaneHostProps & Readonly<{
    bottomPane: React.ReactNode | null;
    bottomPresentation: BottomPanePresentation;
    bottomDockHeightPx: number;
    bottomDockMinHeightPx: number;
    bottomDockMaxHeightPx: number;
    onCloseBottom: () => void;
    onCommitBottomDockHeightPx: (heightPx: number) => void;
    onDragBottomDockHeightPx?: (heightPx: number | null) => void;
}>;

export const MultiPaneHostWithBottom = React.memo((props: MultiPaneHostWithBottomProps) => {
    const {
        bottomPane,
        bottomPresentation,
        bottomDockHeightPx,
        bottomDockMinHeightPx,
        bottomDockMaxHeightPx,
        onCloseBottom,
        onCommitBottomDockHeightPx,
        onDragBottomDockHeightPx,
        ...multiPaneProps
    } = props;

    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotionPreference();
    const overlayDurationMs = reduceMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.base;
    // Shared pane progress also drives docked height interpolation, which requires the JS driver.
    const overlayUseNativeDriver = false;
    const overlayZIndexBase = 80;

    const [bottomOverlayClosing, setBottomOverlayClosing] = React.useState(false);
    const bottomOverlayCloseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (bottomOverlayCloseTimeoutRef.current) clearTimeout(bottomOverlayCloseTimeoutRef.current);
        };
    }, []);

    const bottomTargetOpenBase = Boolean(bottomPane);
    const bottomTargetOpen = bottomTargetOpenBase && !(bottomPresentation === 'overlay' && bottomOverlayClosing);
    const bottomPresence = usePaneAnimatedPresence({
        targetOpen: bottomTargetOpen,
        node: bottomPane,
        durationMs: overlayDurationMs,
        useNativeDriver: overlayUseNativeDriver,
    });
    const shouldRenderBottomPane = bottomPresence.present;
    const renderedBottomPane = bottomPresence.node;

    React.useEffect(() => {
        if (!bottomPane) return;
        return registerEscapeKeyBlocker(ESCAPE_KEY_BLOCKER_PRIORITIES.bottomPane);
    }, [bottomPane]);

    const requestCloseOverlayBottom = React.useCallback(() => {
        if (bottomOverlayCloseTimeoutRef.current) {
            clearTimeout(bottomOverlayCloseTimeoutRef.current);
            bottomOverlayCloseTimeoutRef.current = null;
        }

        if (bottomPresentation !== 'overlay' || !bottomPresence.present) {
            onCloseBottom();
            return;
        }

        if (reduceMotion) {
            onCloseBottom();
            return;
        }

        setBottomOverlayClosing(true);
        Animated.timing(bottomPresence.progress, {
            toValue: 0,
            duration: overlayDurationMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: overlayUseNativeDriver,
        }).start();
        bottomOverlayCloseTimeoutRef.current = setTimeout(() => {
            bottomOverlayCloseTimeoutRef.current = null;
            onCloseBottom();
            setBottomOverlayClosing(false);
        }, overlayDurationMs);
    }, [bottomPresentation, bottomPresence.present, bottomPresence.progress, onCloseBottom, overlayDurationMs, overlayUseNativeDriver, reduceMotion]);

    React.useLayoutEffect(() => {
        const maybeWindow: any = (globalThis as any).window;
        if (!maybeWindow?.addEventListener) return;
        if (!bottomPane) return;

        const onKeyDownCapture = (event: any) => {
            if (event?.key !== 'Escape') return;
            if (event?.defaultPrevented) return;
            const target = event?.target;
            const tagNameRaw = typeof target?.tagName === 'string' ? target.tagName : '';
            const tagName = String(tagNameRaw).toLowerCase();
            if (tagName === 'input' || tagName === 'textarea') return;
            if (target?.isContentEditable) return;

            markEscapeEventHandled(event);
            event?.preventDefault?.();
            event?.stopImmediatePropagation?.();
            event?.stopPropagation?.();

            if (bottomPresentation === 'overlay' && bottomPresence.present) {
                requestCloseOverlayBottom();
                return;
            }

            onCloseBottom();
        };

        maybeWindow.addEventListener('keydown', onKeyDownCapture, true);
        return () => {
            maybeWindow.removeEventListener?.('keydown', onKeyDownCapture, true);
        };
    }, [bottomPane, bottomPresentation, bottomPresence.present, onCloseBottom, requestCloseOverlayBottom]);

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                <MultiPaneHost {...multiPaneProps} />
            </View>

            {shouldRenderBottomPane ? (
                <Animated.View
                    testID={bottomPresentation === 'overlay' ? 'multi-pane-bottom-overlay' : undefined}
                    style={
                        bottomPresentation === 'overlay'
                            ? {
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: 0,
                                zIndex: overlayZIndexBase + 1,
                                backgroundColor: theme.colors.surface,
                                borderTopWidth: 1,
                                borderTopColor: theme.colors.divider,
                                overflow: 'hidden',
                                transform: [{
                                    translateY: bottomPresence.progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [Math.max(24, bottomDockHeightPx), 0],
                                    }),
                                }],
                                opacity: bottomPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1],
                                }),
                            }
                            : {
                                position: 'relative',
                                alignSelf: 'stretch',
                                width: '100%',
                                height: bottomPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, bottomDockHeightPx],
                                }),
                                overflow: 'hidden',
                                opacity: bottomPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1],
                                }),
                                transform: [{
                                    translateY: bottomPresence.progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [12, 0],
                                    }),
                                }],
                            }
                    }
                >
                    <ResizableDockedPaneVertical
                        testID={bottomPresentation === 'overlay' ? 'multi-pane-bottom-overlay-pane' : 'multi-pane-bottom-dock'}
                        resizeHandleTestID={
                            bottomPresentation === 'overlay'
                                ? 'multi-pane-bottom-overlay-resize-handle'
                                : 'multi-pane-bottom-dock-resize-handle'
                        }
                        heightPx={bottomDockHeightPx}
                        minHeightPx={bottomDockMinHeightPx}
                        maxHeightPx={bottomDockMaxHeightPx}
                        resizeEdge="top"
                        onCommitHeightPx={onCommitBottomDockHeightPx}
                        onDragHeightPx={onDragBottomDockHeightPx}
                    >
                        {renderedBottomPane}
                    </ResizableDockedPaneVertical>
                </Animated.View>
            ) : null}

            {bottomPresentation === 'overlay' && bottomPresence.present ? (
                <>
                    <PaneAnimatedScrimPressable
                        testID="multi-pane-bottom-scrim"
                        accessibilityRole="button"
                        onPress={requestCloseOverlayBottom}
                        animatedStyle={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            zIndex: overlayZIndexBase,
                            backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                            opacity: bottomPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0, 1],
                            }),
                        }}
                    />

                </>
            ) : null}
        </View>
    );
});
