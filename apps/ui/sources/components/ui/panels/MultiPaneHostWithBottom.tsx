import * as React from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { MultiPaneHost, type MultiPaneHostProps } from './MultiPaneHost';
import { ResizableDockedPaneVertical } from './resizable/ResizableDockedPaneVertical';
import { ESCAPE_KEY_BLOCKER_PRIORITIES, markEscapeEventHandled, registerEscapeKeyBlocker } from './escapeKeyHandling';
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
    const overlayUseNativeDriver = Platform.OS !== 'web';
    const overlayZIndexBase = 80;

    const [bottomOverlayClosing, setBottomOverlayClosing] = React.useState(false);
    const bottomOverlayCloseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (bottomOverlayCloseTimeoutRef.current) clearTimeout(bottomOverlayCloseTimeoutRef.current);
        };
    }, []);

    const useAnimatedPresence = (input: {
        targetOpen: boolean;
        node: React.ReactNode | null;
    }) => {
        const { targetOpen, node } = input;
        const progress = React.useRef(new Animated.Value(targetOpen ? 1 : 0)).current;
        const nodeRef = React.useRef<React.ReactNode | null>(node);
        const [present, setPresent] = React.useState(targetOpen);
        const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

        React.useEffect(() => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }

            if (targetOpen) {
                nodeRef.current = node;
                setPresent(true);
                Animated.timing(progress, {
                    toValue: 1,
                    duration: overlayDurationMs,
                    easing: motionTokens.easing.standard,
                    useNativeDriver: overlayUseNativeDriver,
                }).start();
                return;
            }

            if (!present) return;
            Animated.timing(progress, {
                toValue: 0,
                duration: overlayDurationMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: overlayUseNativeDriver,
            }).start();
            timeoutRef.current = setTimeout(() => {
                timeoutRef.current = null;
                setPresent(false);
            }, overlayDurationMs);
        }, [node, overlayDurationMs, overlayUseNativeDriver, present, progress, targetOpen]);

        React.useEffect(() => {
            return () => {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
            };
        }, []);

        return {
            present,
            node: present ? nodeRef.current : null,
            progress,
        };
    };

    const bottomTargetOpenBase = Boolean(bottomPane) && bottomPresentation === 'overlay';
    const bottomTargetOpen = bottomTargetOpenBase && !(bottomPresentation === 'overlay' && bottomOverlayClosing);
    const bottomPresence = useAnimatedPresence({ targetOpen: bottomTargetOpen, node: bottomPane });
    const shouldRenderBottomPane = Boolean(bottomPane) || bottomPresence.present;
    const renderedBottomPane = bottomPresentation === 'overlay' ? bottomPresence.node : bottomPane;

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
                    <AnimatedPressable
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

const AnimatedPressable = React.memo((props: Readonly<{
    testID: string;
    accessibilityRole: 'button';
    onPress: () => void;
    animatedStyle: any;
}>) => {
    return (
        <Animated.View style={props.animatedStyle}>
            <Pressable
                testID={props.testID}
                accessibilityRole={props.accessibilityRole}
                onPress={props.onPress}
                style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
            />
        </Animated.View>
    );
});
