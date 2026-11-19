import * as React from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { ResizableDockedPane } from './ResizableDockedPane';
import { ESCAPE_KEY_BLOCKER_PRIORITIES, getMaxEscapeKeyBlockerPriority, isEscapeEventHandled } from './escapeKeyHandling';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { shadowLevelStyle } from '@/shadowElevation';

// One radius wherever a pane meets the header. The header spans above these columns and is not
// part of them, so a square top-left corner reads as a slab wedged underneath; rounding it lets
// the pane sit into the header instead. Matches the content sheet's seam radius.
const PANE_TOP_CORNER_RADIUS_PX = 16;
const overlayPaneCorners = {
    borderTopLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
    borderBottomLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
};
const overlayPaneContentStyle = { ...overlayPaneCorners, overflow: 'hidden' as const };

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
    const overlayUseNativeDriver = Platform.OS !== 'web';
    const overlayZIndexBase = 50;

    // One surface for both docked panes. Details and right are separate columns wearing identical
    // chrome; while this lived inline in each of them the two copies had to be edited in lockstep,
    // which is exactly the shape that lets one quietly fall behind the other.
    const dockedPaneSurfaceStyle = React.useMemo(() => ({
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
        borderTopLeftRadius: PANE_TOP_CORNER_RADIUS_PX,
        // Required for the radius to be visible at all: the pane's children paint their own
        // backgrounds (the tab strip's inset fill) straight into the corner otherwise. An element's
        // own `overflow` clips its DESCENDANTS, not the shadow it casts itself, so the seam below
        // survives this.
        overflow: 'hidden' as const,
        // Seam, not a border. The docked pane sits ABOVE the main content, so it casts onto it
        // rather than being fenced off by a line — the same treatment as the sidebar/content seam,
        // mirrored. x-offset only, wide blur, no spread: the cast hugs the edge and stays a gradient
        // rather than reading as a second divider. Web-only; native keeps the hairline alone because
        // this cast is not expressible in the native shadow API.
        //
        // Hairline AND cast, deliberately. This is the one place the border-XOR-shadow rule bends:
        // the pane is a sibling column rather than a floating surface, so the cast alone reads as a
        // smudge without a defined edge. The hairline gives the edge, the cast gives the depth.
        //
        // Both edges that face the app get the line. The pane is inset from the top as well as the
        // left — the header runs above it — so stopping at the left edge left the rounded corner
        // trailing off into nothing where the arc turned horizontal.
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderTopWidth: StyleSheet.hairlineWidth,
        // Half the weight of border.default on purpose. The cast already carries the separation, so
        // this line only has to define the edge — at full token strength it competes with the shadow
        // and reads as a divider again. Expressed as alpha, not a flat hex, so it composites over
        // whatever the pane is sitting on.
        borderLeftColor: theme.colors.border.subtle,
        borderTopColor: theme.colors.border.subtle,
        ...(Platform.OS === 'web'
            ? {
                boxShadow: theme.dark
                    ? '-5px 0 22px rgba(0, 0, 0, 0.13)'
                    : '-5px 0 22px rgba(0, 0, 0, 0.035)',
            }
            : {}),
    }), [theme]);

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
                            backgroundColor: theme.colors.surface.base,
                            // Overlay only. Docked, this pane is part of the layout and its seam is
                            // the hairline border; floating above the content it is a modal surface,
                            // so it takes the modal elevation and rounds the one edge that shows.
                            // Clip the content inside the resizer so the handle can extend out.
                            ...overlayPaneCorners,
                            ...shadowLevelStyle(theme.colors.shadowLevels[6]),
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
                            contentStyle={overlayPaneContentStyle}
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
                            backgroundColor: theme.colors.surface.base,
                            opacity: layout.right === 'overlay' ? 1 : 0,
                            // Same rule as the details overlay: a floating pane is a modal surface,
                            // a hidden/parked one is not.
                            ...(layout.right === 'overlay'
                                ? {
                                    ...overlayPaneCorners,
                                    ...shadowLevelStyle(theme.colors.shadowLevels[6]),
                                }
                                : null),
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
                            contentStyle={layout.right === 'overlay' ? overlayPaneContentStyle : undefined}
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
                    <View style={dockedPaneSurfaceStyle}>
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
                    <View style={dockedPaneSurfaceStyle}>
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
