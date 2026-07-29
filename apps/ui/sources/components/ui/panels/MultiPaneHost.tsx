import * as React from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { ResizableDockedPane } from './ResizableDockedPane';
import { ESCAPE_KEY_BLOCKER_PRIORITIES, getMaxEscapeKeyBlockerPriority, isEscapeEventHandled } from './escapeKeyHandling';
import { usePaneAnimatedPresence } from './motion/usePaneAnimatedPresence';
import { PaneAnimatedScrimPressable } from './motion/PaneAnimatedScrimPressable';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type MultiPaneHostProps = Readonly<{
    main: React.ReactNode;
    hideMain?: boolean;
    rightPane: React.ReactNode | null;
    detailsPane: React.ReactNode | null;
    layout: ResolvedPaneLayout;
    rightDockWidthPx: number;
    detailsDockWidthPx: number;
    rightDockMinWidthPx?: number;
    rightDockMaxWidthPx?: number;
    detailsDockMinWidthPx?: number;
    detailsDockMaxWidthPx?: number;
    onCloseRight: () => void;
    onCloseDetails: () => void;
    onCommitRightDockWidthPx: (widthPx: number) => void;
    onCommitDetailsDockWidthPx: (widthPx: number) => void;
    onDragRightDockWidthPx?: (widthPx: number | null) => void;
    onDragDetailsDockWidthPx?: (widthPx: number | null) => void;
}>;

export const MultiPaneHost = React.memo((props: MultiPaneHostProps) => {
    const {
        main,
        hideMain,
        rightPane,
        detailsPane,
        layout,
        rightDockWidthPx,
        detailsDockWidthPx,
        onCloseRight,
        onCloseDetails,
    } = props;

    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotionPreference();
    const overlayDurationMs = reduceMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.base;
    // Shared pane progress also drives docked width/height interpolation, which requires the JS driver.
    const overlayUseNativeDriver = false;
    const overlayZIndexBase = 50;

    const [rightOverlayClosing, setRightOverlayClosing] = React.useState(false);
    const [detailsOverlayClosing, setDetailsOverlayClosing] = React.useState(false);
    const rightOverlayCloseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const detailsOverlayCloseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (rightOverlayCloseTimeoutRef.current) clearTimeout(rightOverlayCloseTimeoutRef.current);
            if (detailsOverlayCloseTimeoutRef.current) clearTimeout(detailsOverlayCloseTimeoutRef.current);
        };
    }, []);

    // Pane *presence* is the logical open signal. Layout controls whether it's docked/overlay/hidden.
    // This lets us keep a pane mounted (state preserved) even when the layout temporarily hides it
    // (e.g. overlayStack where details overlays and right is hidden).
    const detailsTargetOpenBase = Boolean(detailsPane);
    const rightTargetOpenBase = Boolean(rightPane);

    const detailsTargetOpen =
        detailsTargetOpenBase && !(layout.details === 'overlay' && detailsOverlayClosing);
    const rightTargetOpen =
        rightTargetOpenBase && !(layout.right === 'overlay' && rightOverlayClosing);

    const detailsPresence = usePaneAnimatedPresence({
        targetOpen: detailsTargetOpen,
        node: detailsPane,
        durationMs: overlayDurationMs,
        useNativeDriver: overlayUseNativeDriver,
    });
    const rightPresence = usePaneAnimatedPresence({
        targetOpen: rightTargetOpen,
        node: rightPane,
        durationMs: overlayDurationMs,
        useNativeDriver: overlayUseNativeDriver,
    });

    const requestCloseOverlayDetails = React.useCallback(() => {
        if (detailsOverlayCloseTimeoutRef.current) {
            clearTimeout(detailsOverlayCloseTimeoutRef.current);
            detailsOverlayCloseTimeoutRef.current = null;
        }
        if (layout.details !== 'overlay' || !detailsPresence.present) {
            onCloseDetails();
            return;
        }
        if (reduceMotion) {
            onCloseDetails();
            return;
        }
        setDetailsOverlayClosing(true);
        Animated.timing(detailsPresence.progress, {
            toValue: 0,
            duration: overlayDurationMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: overlayUseNativeDriver,
        }).start();
        detailsOverlayCloseTimeoutRef.current = setTimeout(() => {
            detailsOverlayCloseTimeoutRef.current = null;
            onCloseDetails();
            setDetailsOverlayClosing(false);
        }, overlayDurationMs);
    }, [detailsPresence.present, detailsPresence.progress, layout.details, onCloseDetails, overlayDurationMs, overlayUseNativeDriver, reduceMotion]);

    const requestCloseOverlayRight = React.useCallback(() => {
        if (rightOverlayCloseTimeoutRef.current) {
            clearTimeout(rightOverlayCloseTimeoutRef.current);
            rightOverlayCloseTimeoutRef.current = null;
        }
        if (layout.right !== 'overlay' || !rightPresence.present) {
            onCloseRight();
            return;
        }
        if (reduceMotion) {
            onCloseRight();
            return;
        }
        setRightOverlayClosing(true);
        Animated.timing(rightPresence.progress, {
            toValue: 0,
            duration: overlayDurationMs,
            easing: motionTokens.easing.standard,
            useNativeDriver: overlayUseNativeDriver,
        }).start();
        rightOverlayCloseTimeoutRef.current = setTimeout(() => {
            rightOverlayCloseTimeoutRef.current = null;
            onCloseRight();
            setRightOverlayClosing(false);
        }, overlayDurationMs);
    }, [layout.right, onCloseRight, overlayDurationMs, overlayUseNativeDriver, reduceMotion, rightPresence.present, rightPresence.progress]);

    React.useEffect(() => {
        const maybeWindow: any = (globalThis as any).window;
        if (!maybeWindow?.addEventListener) return;

        const shouldListen =
            ((layout.right === 'overlay' || layout.right === 'docked') && rightPresence.present) ||
            ((layout.details === 'overlay' || layout.details === 'docked') && detailsPresence.present);
        if (!shouldListen) return;

        const onKeyDown = (event: any) => {
            if (event?.key !== 'Escape') return;
            if (isEscapeEventHandled(event)) return;
            if (event?.defaultPrevented) return;
            const target = event?.target;
            const tagNameRaw = typeof target?.tagName === 'string' ? target.tagName : '';
            const tagName = String(tagNameRaw).toLowerCase();
            if (tagName === 'input' || tagName === 'textarea') return;
            if (target?.isContentEditable) return;
            if (getMaxEscapeKeyBlockerPriority() > ESCAPE_KEY_BLOCKER_PRIORITIES.panes) return;

            if (layout.details === 'overlay' && detailsPresence.present) {
                requestCloseOverlayDetails();
                return;
            }
            if (layout.right === 'overlay' && rightPresence.present) {
                requestCloseOverlayRight();
                return;
            }
            if (layout.details === 'docked' && detailsPresence.present) {
                requestCloseOverlayDetails();
                return;
            }
            if (layout.right === 'docked' && rightPresence.present) {
                requestCloseOverlayRight();
            }
        };

        maybeWindow.addEventListener('keydown', onKeyDown);
        return () => {
            maybeWindow.removeEventListener?.('keydown', onKeyDown);
        };
    }, [
        detailsPresence.present,
        layout.details,
        layout.right,
        requestCloseOverlayDetails,
        requestCloseOverlayRight,
        rightPresence.present,
    ]);

    const mainRegion = (
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
            {main}

            {layout.details === 'overlay' && detailsPresence.present ? (
                <>
                    <PaneAnimatedScrimPressable
                        testID="multi-pane-details-scrim"
                        accessibilityRole="button"
                        onPress={requestCloseOverlayDetails}
                        animatedStyle={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            zIndex: overlayZIndexBase,
                            backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                            opacity: detailsPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0, 1],
                            }),
                        }}
                    />
                    <Animated.View
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: overlayZIndexBase + 1,
                            backgroundColor: theme.colors.surface.base,
                            transform: [
                                {
                                    translateX: detailsPresence.progress.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [detailsDockWidthPx, 0],
                                    }),
                                },
                            ],
                        }}
                    >
                        <ResizableDockedPane
                            testID="multi-pane-details-overlay"
                            widthPx={detailsDockWidthPx}
                            minWidthPx={props.detailsDockMinWidthPx ?? 320}
                            maxWidthPx={props.detailsDockMaxWidthPx ?? 900}
                            onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                            onDragWidthPx={props.onDragDetailsDockWidthPx}
                        >
                            {detailsPresence.node}
                        </ResizableDockedPane>
                    </Animated.View>
                </>
            ) : null}

            {layout.kind === 'overlayStack' && rightPresence.present && (layout.right === 'overlay' || layout.right === 'hidden') ? (
                <>
                    {layout.right === 'overlay' ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-right-scrim"
                            accessibilityRole="button"
                            onPress={requestCloseOverlayRight}
                            animatedStyle={{
                                position: 'absolute',
                                top: 0,
                                right: 0,
                                bottom: 0,
                                left: 0,
                                zIndex: overlayZIndexBase + 2,
                                backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
                                opacity: rightPresence.progress.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0, 1],
                                }),
                            }}
                        />
                    ) : null}
                    <Animated.View
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: layout.right === 'overlay' ? overlayZIndexBase + 3 : overlayZIndexBase - 1,
                            backgroundColor: theme.colors.surface.base,
                            opacity: layout.right === 'overlay' ? 1 : 0,
                            transform: [
                                {
                                    translateX: layout.right === 'overlay'
                                        ? rightPresence.progress.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [rightDockWidthPx, 0],
                                        })
                                        : rightDockWidthPx,
                                },
                            ],
                        }}
                    >
                        <ResizableDockedPane
                            testID="multi-pane-right-overlay"
                            widthPx={rightDockWidthPx}
                            minWidthPx={props.rightDockMinWidthPx ?? 260}
                            maxWidthPx={props.rightDockMaxWidthPx ?? 720}
                            onCommitWidthPx={props.onCommitRightDockWidthPx}
                            onDragWidthPx={props.onDragRightDockWidthPx}
                        >
                            {rightPresence.node}
                        </ResizableDockedPane>
                    </Animated.View>
                </>
            ) : null}
        </View>
    );

    const detailsDocked =
        layout.details === 'docked' && detailsPresence.present ? (
            <Animated.View
                style={{
                    width: detailsPresence.progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, detailsDockWidthPx],
                    }),
                    overflow: 'hidden',
                    flexShrink: 0,
                    alignSelf: 'stretch',
                    height: '100%',
                    // The seam cast lives on this element, not the inner surface: overflow:'hidden'
                    // above clips any shadow a child tries to throw past the pane edge. An element's
                    // own shadow is not clipped by its own overflow, so this is the only owner that
                    // can reach the main content. x-offset only, no spread, web-only.
                    ...(Platform.OS === 'web'
                        ? {
                            boxShadow: theme.dark
                                ? '-5px 0 22px rgba(0, 0, 0, 0.13)'
                                : '-5px 0 22px rgba(0, 0, 0, 0.035)',
                        }
                        : {}),
                    opacity: detailsPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                    transform: [
                        {
                            translateX: detailsPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [12, 0],
                            }),
                        },
                    ],
                }}
            >
                <ResizableDockedPane
                    testID="multi-pane-details-docked"
                    widthPx={detailsDockWidthPx}
                    minWidthPx={props.detailsDockMinWidthPx ?? 320}
                    maxWidthPx={props.detailsDockMaxWidthPx ?? 900}
                    onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                    onDragWidthPx={props.onDragDetailsDockWidthPx}
                >
                    <View
                        style={{
                            flex: 1,
                            minHeight: 0,
                            minWidth: 0,
                            borderLeftWidth: StyleSheet.hairlineWidth,
                            // Half the weight of border.default on purpose: the wrapper's cast
                            // carries the separation, so this line only has to define the edge.
                            // Alpha, not a flat hex, so it composites over whatever is behind.
                            borderLeftColor: theme.dark
                                ? 'rgba(255, 255, 255, 0.025)'
                                : 'rgba(0, 0, 0, 0.041)',
                            backgroundColor: theme.colors.surface.base,
                        }}
                    >
                        {detailsPresence.node}
                    </View>
                </ResizableDockedPane>
            </Animated.View>
        ) : null;

    const rightDocked =
        layout.right === 'docked' && rightPresence.present ? (
            <Animated.View
                style={{
                    width: rightPresence.progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, rightDockWidthPx],
                    }),
                    overflow: 'hidden',
                    flexShrink: 0,
                    alignSelf: 'stretch',
                    height: '100%',
                    // The seam cast lives on this element, not the inner surface: overflow:'hidden'
                    // above clips any shadow a child tries to throw past the pane edge. An element's
                    // own shadow is not clipped by its own overflow, so this is the only owner that
                    // can reach the main content. x-offset only, no spread, web-only.
                    ...(Platform.OS === 'web'
                        ? {
                            boxShadow: theme.dark
                                ? '-5px 0 22px rgba(0, 0, 0, 0.13)'
                                : '-5px 0 22px rgba(0, 0, 0, 0.035)',
                        }
                        : {}),
                    opacity: rightPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                    transform: [
                        {
                            translateX: rightPresence.progress.interpolate({
                                inputRange: [0, 1],
                                outputRange: [12, 0],
                            }),
                        },
                    ],
                }}
            >
                <ResizableDockedPane
                    testID="multi-pane-right-docked"
                    widthPx={rightDockWidthPx}
                    minWidthPx={props.rightDockMinWidthPx ?? 260}
                    maxWidthPx={props.rightDockMaxWidthPx ?? 720}
                    onCommitWidthPx={props.onCommitRightDockWidthPx}
                    onDragWidthPx={props.onDragRightDockWidthPx}
                >
                    <View
                        style={{
                            flex: 1,
                            minHeight: 0,
                            minWidth: 0,
                            borderLeftWidth: StyleSheet.hairlineWidth,
                            // Half the weight of border.default on purpose: the wrapper's cast
                            // carries the separation, so this line only has to define the edge.
                            // Alpha, not a flat hex, so it composites over whatever is behind.
                            borderLeftColor: theme.dark
                                ? 'rgba(255, 255, 255, 0.025)'
                                : 'rgba(0, 0, 0, 0.041)',
                            backgroundColor: theme.colors.surface.base,
                        }}
                    >
                        {rightPresence.node}
                    </View>
                </ResizableDockedPane>
            </Animated.View>
        ) : null;

    const shouldHideDockedMainRegion = hideMain === true
        && layout.details !== 'overlay'
        && layout.right !== 'overlay';

    return (
        <View style={{ flex: 1, flexDirection: 'row' }}>
            {[
                // Keep the main region under the same keyed parent for single and multi-pane
                // layouts so opening or closing a docked pane does not remount the transcript.
                shouldHideDockedMainRegion ? null : <React.Fragment key="main">{mainRegion}</React.Fragment>,
                detailsDocked ? <React.Fragment key="details">{detailsDocked}</React.Fragment> : null,
                rightDocked ? <React.Fragment key="right">{rightDocked}</React.Fragment> : null,
            ]}
        </View>
    );
});
