import * as React from 'react';
import { Animated, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { ResizableDockedPane } from './ResizableDockedPane';
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
                    useNativeDriver: true,
                }).start();
                return;
            }

            if (!present) return;
            Animated.timing(progress, {
                toValue: 0,
                duration: overlayDurationMs,
                easing: motionTokens.easing.standard,
                useNativeDriver: true,
            }).start();
            timeoutRef.current = setTimeout(() => {
                timeoutRef.current = null;
                setPresent(false);
            }, overlayDurationMs);
        }, [node, overlayDurationMs, present, progress, targetOpen]);

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

    // Pane *presence* is the logical open signal. Layout controls whether it's docked/overlay/hidden.
    // This lets us keep a pane mounted (state preserved) even when the layout temporarily hides it
    // (e.g. overlayStack where details overlays and right is hidden).
    const detailsTargetOpenBase = Boolean(detailsPane);
    const rightTargetOpenBase = Boolean(rightPane);

    const detailsTargetOpen =
        detailsTargetOpenBase && !(layout.details === 'overlay' && detailsOverlayClosing);
    const rightTargetOpen =
        rightTargetOpenBase && !(layout.right === 'overlay' && rightOverlayClosing);

    const detailsPresence = useAnimatedPresence({ targetOpen: detailsTargetOpen, node: detailsPane });
    const rightPresence = useAnimatedPresence({ targetOpen: rightTargetOpen, node: rightPane });

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
            useNativeDriver: true,
        }).start();
        detailsOverlayCloseTimeoutRef.current = setTimeout(() => {
            detailsOverlayCloseTimeoutRef.current = null;
            onCloseDetails();
            setDetailsOverlayClosing(false);
        }, overlayDurationMs);
    }, [detailsPresence.present, detailsPresence.progress, layout.details, onCloseDetails, overlayDurationMs, reduceMotion]);

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
            useNativeDriver: true,
        }).start();
        rightOverlayCloseTimeoutRef.current = setTimeout(() => {
            rightOverlayCloseTimeoutRef.current = null;
            onCloseRight();
            setRightOverlayClosing(false);
        }, overlayDurationMs);
    }, [layout.right, onCloseRight, overlayDurationMs, reduceMotion, rightPresence.present, rightPresence.progress]);

    React.useEffect(() => {
        const maybeWindow: any = (globalThis as any).window;
        if (!maybeWindow?.addEventListener) return;

        const shouldListen =
            ((layout.right === 'overlay' || layout.right === 'docked') && rightPresence.present) ||
            ((layout.details === 'overlay' || layout.details === 'docked') && detailsPresence.present);
        if (!shouldListen) return;

        const onKeyDown = (event: any) => {
            if (event?.key !== 'Escape') return;
            if (event?.defaultPrevented) return;
            const target = event?.target;
            const tagNameRaw = typeof target?.tagName === 'string' ? target.tagName : '';
            const tagName = String(tagNameRaw).toLowerCase();
            if (tagName === 'input' || tagName === 'textarea') return;
            if (target?.isContentEditable) return;

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
        <View style={{ flex: 1, position: 'relative' }}>
            {main}

            {layout.details === 'overlay' && detailsPresence.present ? (
                <>
                    <AnimatedPressable
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
                            backgroundColor: theme.colors.surface,
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
                        <AnimatedPressable
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
                            backgroundColor: theme.colors.surface,
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

    if (layout.kind === 'single') return mainRegion;
    const detailsDocked =
        layout.details === 'docked' && detailsPresence.present ? (
            <Animated.View
                style={{
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
                            borderLeftWidth: 1,
                            borderLeftColor: theme.colors.divider,
                            backgroundColor: theme.colors.surface,
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
                            borderLeftWidth: 1,
                            borderLeftColor: theme.colors.divider,
                            backgroundColor: theme.colors.surface,
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
                shouldHideDockedMainRegion ? null : <React.Fragment key="main">{mainRegion}</React.Fragment>,
                detailsDocked ? <React.Fragment key="details">{detailsDocked}</React.Fragment> : null,
                rightDocked ? <React.Fragment key="right">{rightDocked}</React.Fragment> : null,
            ]}
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
