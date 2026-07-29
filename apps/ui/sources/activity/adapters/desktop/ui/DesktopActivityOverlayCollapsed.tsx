import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useScreenReaderEnabled } from '@/hooks/ui/useScreenReaderEnabled';

import {
    DesktopActivityOverlayChromeBackdrop,
    createDesktopActivityOverlayChromeStyle,
    createDesktopActivityOverlayInteriorSurfaceStyle,
    DesktopActivityOverlayChromeHighlights,
} from './DesktopActivityOverlayChrome';
import { DesktopActivityOverlayBrandMark } from './DesktopActivityOverlayBrandMark';
import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';
import { useDesktopActivityOverlayMotionProgress } from './DesktopActivityOverlayMotionFrame';
import {
    resolveDesktopActivityOverlaySurfaceTestID,
    type DesktopActivityOverlayVisualMode,
} from './DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayHoverablePressableState } from './DesktopActivityOverlayHoverablePressableState';
import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';
import { DESKTOP_OVERLAY_BOUNCE_SPRING } from '../motion/desktopOverlaySprings';
import {
    DESKTOP_ACTIVITY_OVERLAY_CRITICAL_UNATTENDED_MS,
    DESKTOP_ACTIVITY_OVERLAY_NEEDS_YOU_UNATTENDED_MS,
} from '../desktopActivityOverlayTiming';

export const DESKTOP_ACTIVITY_OVERLAY_CAMERA_SPACER_NOTCH_WIDTH_RATIO = 0.35;
export const DESKTOP_ACTIVITY_OVERLAY_DEFAULT_CAMERA_SPACER_WIDTH = 90;

const COLLAPSED_SLIDE_PRIORITY_RANK: Record<string, number> = {
    idle: 0,
    running: 1,
    ready: 2,
    attention: 3,
};

const DESKTOP_OVERLAY_URGENCY_PULSE_DURATION_MS = 1200;
const DESKTOP_OVERLAY_STANDBY_FADE_DURATION_MS = 500;
const DESKTOP_OVERLAY_SLIDE_PUSH_DURATION_MS = 300;
const DESKTOP_OVERLAY_SLIDE_PUSH_OFFSET_Y = 6;

function resolveNotchCameraSpacerWidth(physicalNotchWidth: number | null | undefined): number {
    if (typeof physicalNotchWidth === 'number' && Number.isFinite(physicalNotchWidth) && physicalNotchWidth > 0) {
        return physicalNotchWidth * DESKTOP_ACTIVITY_OVERLAY_CAMERA_SPACER_NOTCH_WIDTH_RATIO;
    }
    return DESKTOP_ACTIVITY_OVERLAY_DEFAULT_CAMERA_SPACER_WIDTH;
}

function resolveNotchWingContentInset(
    windowWidth: number | null | undefined,
    physicalNotchWidth: number | null | undefined,
): number {
    if (
        typeof windowWidth === 'number'
        && Number.isFinite(windowWidth)
        && typeof physicalNotchWidth === 'number'
        && Number.isFinite(physicalNotchWidth)
        && windowWidth > physicalNotchWidth
    ) {
        return Math.max(
            desktopActivityOverlayChromeMetrics.collapsed.notchContentInset,
            (windowWidth - physicalNotchWidth) / 2,
        );
    }

    return desktopActivityOverlayChromeMetrics.collapsed.notchContentInset;
}

function selectMostUrgentSlideIndex(
    slides: readonly NonNullable<DesktopActivityOverlayUiModel['collapsed']['slides']>[number][],
): number {
    let selectedIndex = 0;
    let selectedRank = Number.NEGATIVE_INFINITY;
    slides.forEach((slide, index) => {
        const rank = COLLAPSED_SLIDE_PRIORITY_RANK[slide.priority] ?? 0;
        if (rank > selectedRank) {
            selectedRank = rank;
            selectedIndex = index;
        }
    });
    return selectedIndex;
}

function resolveRenderedUrgencyLevel(params: Readonly<{
    level: 'idle' | 'running' | 'needs_you' | 'critical';
    unattendedMs: number;
    elapsedMs: number;
}>): 'idle' | 'running' | 'needs_you' | 'critical' {
    if (params.level === 'idle' || params.level === 'running') {
        return params.level;
    }
    const unattendedMs = params.unattendedMs + Math.max(0, params.elapsedMs);
    if (unattendedMs >= DESKTOP_ACTIVITY_OVERLAY_CRITICAL_UNATTENDED_MS) {
        return 'critical';
    }
    if (unattendedMs >= DESKTOP_ACTIVITY_OVERLAY_NEEDS_YOU_UNATTENDED_MS) {
        return 'needs_you';
    }
    return params.level;
}

export function DesktopActivityOverlayCollapsed(props: Readonly<{
    model: DesktopActivityOverlayUiModel;
    visualMode: DesktopActivityOverlayVisualMode;
    physicalNotchWidth?: number | null;
    dragHandlers: Readonly<Record<string, unknown>>;
    onPress: () => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const openProgress = useDesktopActivityOverlayMotionProgress();
    const reduceMotion = useReducedMotionPreference();
    const screenReaderEnabled = useScreenReaderEnabled();
    const isNotchIntegrated = props.visualMode === 'notch_integrated';
    const surfaceTestID = resolveDesktopActivityOverlaySurfaceTestID('desktop-activity-overlay-collapsed', props.visualMode);
    const slides = props.model.collapsed.slides ?? [{
        id: 'status' as const,
        title: props.model.collapsed.title,
        subtitle: props.model.collapsed.statusText,
        animatedEllipsis: false,
        priority: 'idle' as const,
    }];
    const [activeSlideIndex, setActiveSlideIndex] = React.useState(0);
    const [ellipsisFrame, setEllipsisFrame] = React.useState(1);
    const [urgencyNowMs, setUrgencyNowMs] = React.useState(props.model.generatedAt);
    const carousel = props.model.collapsed.carousel;
    const carouselCanRotate = carousel?.enabled === true
        && !reduceMotion
        && !screenReaderEnabled
        && slides.length > 1
        && carousel.cadenceMs > 0;
    const resolvedActiveSlideIndex = screenReaderEnabled
        ? selectMostUrgentSlideIndex(slides)
        : Math.min(activeSlideIndex, Math.max(0, slides.length - 1));
    const activeSlide = slides[resolvedActiveSlideIndex] ?? slides[0];
    const baseUrgency = props.model.collapsed.urgency;
    const urgencyLevel = resolveRenderedUrgencyLevel({
        level: baseUrgency?.level ?? (props.model.collapsed.statusText ? 'needs_you' : 'idle'),
        unattendedMs: baseUrgency?.unattendedMs ?? 0,
        elapsedMs: urgencyNowMs - props.model.generatedAt,
    });
    const urgencyPulseOpacity = useSharedValue(urgencyLevel === 'idle' ? 0.32 : 0.9);
    const readyBounceWidth = useSharedValue(0);
    const standbyFadeOpacity = useSharedValue(1);
    const slidePushProgress = useSharedValue(1);
    const notchCameraSpacerWidth = resolveNotchCameraSpacerWidth(props.physicalNotchWidth);
    const notchWingContentInset = resolveNotchWingContentInset(
        props.model.window.collapsed.width,
        props.physicalNotchWidth,
    );
    const containerStyle = [
        styles.container,
        createDesktopActivityOverlayChromeStyle(theme, {
            visualMode: props.visualMode,
            tone: 'collapsed',
            openProgress,
        }),
    ];
    const accessibilityLabel = [
        activeSlide.title,
        activeSlide.subtitle,
        typeof props.model.collapsed.sessionCount === 'number' ? String(props.model.collapsed.sessionCount) : null,
    ]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .join('. ');

    React.useEffect(() => {
        setActiveSlideIndex(0);
    }, [carousel?.cadenceMs, carousel?.enabled, slides]);

    React.useEffect(() => {
        if (!carouselCanRotate) {
            return;
        }
        const intervalId = setInterval(() => {
            setActiveSlideIndex((previousIndex) => (previousIndex + 1) % slides.length);
        }, carousel?.cadenceMs ?? 0);

        return () => {
            clearInterval(intervalId);
        };
    }, [carousel?.cadenceMs, carouselCanRotate, slides.length]);

    React.useEffect(() => {
        if (!activeSlide.animatedEllipsis || reduceMotion) {
            setEllipsisFrame(1);
            return;
        }
        const intervalId = setInterval(() => {
            setEllipsisFrame((previous) => previous >= 3 ? 1 : previous + 1);
        }, 450);

        return () => {
            clearInterval(intervalId);
        };
    }, [activeSlide.animatedEllipsis, reduceMotion]);

    React.useEffect(() => {
        setUrgencyNowMs(props.model.generatedAt);
    }, [props.model.generatedAt]);

    React.useEffect(() => {
        const pollMs = props.model.collapsed.urgency?.pollMs ?? 0;
        if (pollMs <= 0 || urgencyLevel === 'idle' || urgencyLevel === 'running') {
            return;
        }
        const intervalId = setInterval(() => {
            setUrgencyNowMs(Date.now());
        }, pollMs);

        return () => {
            clearInterval(intervalId);
        };
    }, [props.model.collapsed.urgency?.pollMs, urgencyLevel]);

    const readyBounceCue = props.model.collapsed.transitionCue?.kind === 'bounce_on_ready'
        ? props.model.collapsed.transitionCue
        : null;
    const standbyIdle = urgencyLevel === 'idle';
    const readyBounceKey = readyBounceCue?.key ?? null;
    const slideIdentityKey = `${activeSlide.id}:${activeSlide.title}:${activeSlide.subtitle ?? ''}`;
    const urgencyPulseStyle = useAnimatedStyle(() => ({
        opacity: urgencyPulseOpacity.value,
    }));
    const readyBounceStyle = useAnimatedStyle(() => ({
        width: readyBounceWidth.value,
    }));
    const standbyFadeStyle = useAnimatedStyle(() => ({
        opacity: standbyFadeOpacity.value,
    }));
    const slidePushStyle = useAnimatedStyle(() => ({
        opacity: slidePushProgress.value,
        transform: [{
            translateY: (1 - slidePushProgress.value) * DESKTOP_OVERLAY_SLIDE_PUSH_OFFSET_Y,
        }],
    }));

    React.useEffect(() => {
        if (reduceMotion || urgencyLevel === 'idle') {
            urgencyPulseOpacity.value = urgencyLevel === 'idle' ? 0.32 : 0.9;
            return;
        }
        urgencyPulseOpacity.value = withRepeat(
            withTiming(0.5, { duration: DESKTOP_OVERLAY_URGENCY_PULSE_DURATION_MS }),
            -1,
            true,
        );
    }, [reduceMotion, urgencyLevel, urgencyPulseOpacity]);

    React.useEffect(() => {
        if (!readyBounceKey) {
            readyBounceWidth.value = 0;
            return;
        }
        if (reduceMotion) {
            readyBounceWidth.value = 0;
            return;
        }
        const springConfig = {
            duration: DESKTOP_OVERLAY_BOUNCE_SPRING.response * 1000,
            dampingRatio: DESKTOP_OVERLAY_BOUNCE_SPRING.dampingRatio,
        };
        readyBounceWidth.value = withSequence(
            withSpring(16, springConfig),
            withSpring(0, springConfig),
        );
    }, [readyBounceKey, readyBounceWidth, reduceMotion]);

    React.useEffect(() => {
        const targetOpacity = standbyIdle && isNotchIntegrated ? 0.72 : 1;
        standbyFadeOpacity.value = reduceMotion
            ? targetOpacity
            : withTiming(targetOpacity, { duration: DESKTOP_OVERLAY_STANDBY_FADE_DURATION_MS });
    }, [isNotchIntegrated, reduceMotion, standbyFadeOpacity, standbyIdle]);

    React.useEffect(() => {
        if (reduceMotion) {
            slidePushProgress.value = 1;
            return;
        }
        slidePushProgress.value = 0;
        slidePushProgress.value = withTiming(1, { duration: DESKTOP_OVERLAY_SLIDE_PUSH_DURATION_MS });
    }, [reduceMotion, slideIdentityKey, slidePushProgress]);

    return (
        <Pressable
            testID="desktop-activity-overlay-collapsed"
            accessibilityLabel={accessibilityLabel || undefined}
            onPress={props.onPress}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            style={(state) => {
                const { pressed } = state;
                const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                return [
                    containerStyle,
                    hovered ? { opacity: 0.985 } : null,
                    pressed ? { opacity: 0.92 } : null,
                ];
            }}
            {...props.dragHandlers}
        >
            {readyBounceCue ? (
                <Animated.View
                    pointerEvents="none"
                    testID="desktop-activity-overlay-ready-bounce"
                    style={[styles.readyBounce, readyBounceStyle]}
                />
            ) : null}
            <Animated.View
                pointerEvents="none"
                testID="desktop-activity-overlay-standby-fade"
                data-standby={standbyIdle ? 'idle' : 'active'}
                style={[
                    StyleSheet.absoluteFill,
                    standbyFadeStyle,
                ]}
            />
            <View
                pointerEvents="none"
                testID={surfaceTestID}
                style={StyleSheet.absoluteFill}
            >
                <DesktopActivityOverlayChromeBackdrop
                    theme={theme}
                    visualMode={props.visualMode}
                    tone="collapsed"
                    width={props.model.window.collapsed.width}
                    height={props.model.window.collapsed.height}
                    openProgress={openProgress}
                />
                <DesktopActivityOverlayChromeHighlights
                    theme={theme}
                    tone="collapsed"
                    visualMode={props.visualMode}
                />
            </View>
            {isNotchIntegrated ? (
                <View style={[
                    styles.contentRow,
                    styles.contentRowNotch,
                    { paddingHorizontal: notchWingContentInset },
                ]}>
                    <View style={styles.notchLeadingWing}>
                        <DesktopActivityOverlayBrandMark
                            visualMode={props.visualMode}
                            testID="desktop-activity-overlay-collapsed-brand-mark"
                        />
                        <Animated.View
                            testID={standbyIdle ? 'desktop-activity-overlay-idle-dot' : 'desktop-activity-overlay-urgency-pulse'}
                            data-urgency-level={urgencyLevel}
                            style={[
                                styles.statusDot,
                                {
                                    backgroundColor: standbyIdle
                                        ? theme.colors.accent.orange
                                        : theme.colors.accent.orange,
                                    opacity: standbyIdle ? 0.38 : 0.92,
                                },
                                !standbyIdle ? urgencyPulseStyle : null,
                            ]}
                        />
                    </View>
                    <View
                        testID="desktop-activity-overlay-camera-spacer"
                        style={[styles.notchCameraSpacer, { minWidth: notchCameraSpacerWidth }]}
                    />
                    <View style={styles.notchTrailingCluster}>
                        {typeof props.model.collapsed.sessionCount === 'number' ? (
                            <View style={[
                                styles.countBadge,
                                styles.countBadgeNotch,
                                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                    visualMode: props.visualMode,
                                    kind: 'badge',
                                }),
                            ]}>
                                <Text style={[styles.countText, { color: theme.colors.overlay.foreground }]}>
                                    {String(props.model.collapsed.sessionCount)}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                </View>
            ) : (
                <View style={[styles.contentRow, styles.contentRowFloating]}>
                    <View style={styles.leadingAnchor}>
                        <DesktopActivityOverlayBrandMark
                            visualMode={props.visualMode}
                            testID="desktop-activity-overlay-collapsed-brand-mark"
                        />
                        <Animated.View
                            testID={standbyIdle ? 'desktop-activity-overlay-idle-dot' : 'desktop-activity-overlay-urgency-pulse'}
                            data-urgency-level={urgencyLevel}
                            style={[
                                styles.statusDot,
                                styles.statusDotFloating,
                                { backgroundColor: theme.colors.accent.orange, opacity: standbyIdle ? 0.32 : 0.9 },
                                !standbyIdle ? urgencyPulseStyle : null,
                            ]}
                        />
                    </View>
                    <Animated.View
                        key={slideIdentityKey}
                        testID="desktop-activity-overlay-collapsed-slide"
                        data-swap-direction="push-from-bottom"
                        style={[styles.textContainer, slidePushStyle]}
                    >
                        <View style={styles.titleRow}>
                            <Text numberOfLines={1} style={[styles.title, { color: theme.colors.overlay.foreground }]}>
                                {activeSlide.title}
                            </Text>
                            {activeSlide.animatedEllipsis ? (
                                <Text
                                    testID="desktop-activity-overlay-collapsed-ellipsis"
                                    style={[styles.ellipsis, { color: theme.colors.overlay.foreground }]}
                                >
                                    {'.'.repeat(ellipsisFrame)}
                                </Text>
                            ) : null}
                            {typeof props.model.collapsed.sessionCount === 'number' ? (
                                <View style={[
                                    styles.countBadge,
                                    styles.countBadgeFloating,
                                    createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                        visualMode: props.visualMode,
                                        kind: 'badge',
                                    }),
                                ]}>
                                    <Text style={[styles.countText, { color: theme.colors.overlay.foreground }]}>
                                        {String(props.model.collapsed.sessionCount)}
                                    </Text>
                                </View>
                            ) : null}
                        </View>
                        {activeSlide.subtitle ? (
                            <Text numberOfLines={1} style={[styles.status, { color: theme.colors.overlay.secondaryForeground }]}>
                                {activeSlide.subtitle}
                            </Text>
                        ) : null}
                    </Animated.View>
                </View>
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        minHeight: 38,
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
    },
    contentRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: desktopActivityOverlayChromeMetrics.collapsed.gap,
    },
    leadingAnchor: {
        width: 14,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        position: 'relative',
    },
    contentRowNotch: {
        paddingVertical: desktopActivityOverlayChromeMetrics.collapsed.pillPaddingVertical,
        justifyContent: 'space-between',
    },
    contentRowFloating: {
        paddingHorizontal: desktopActivityOverlayChromeMetrics.collapsed.panelPaddingHorizontal,
        paddingVertical: desktopActivityOverlayChromeMetrics.collapsed.panelPaddingVertical,
    },
    textContainer: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    notchLeadingWing: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 3,
        minWidth: 22,
        flexShrink: 0,
    },
    notchCameraSpacer: {
        flex: 1,
    },
    notchTrailingCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        flex: 1,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0,
    },
    status: {
        fontSize: 9,
        opacity: 0.8,
    },
    countBadge: {
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginLeft: 'auto',
    },
    countBadgeNotch: {
        minWidth: 15,
        height: 14,
        paddingHorizontal: 4,
    },
    countBadgeFloating: {
        minWidth: 16,
        height: 15,
        paddingHorizontal: 4,
    },
    countText: {
        fontSize: 8,
        fontWeight: '600',
        letterSpacing: 0,
    },
    statusDot: {
        width: 5,
        height: 5,
        borderRadius: 999,
    },
    statusDotFloating: {
        position: 'absolute',
        right: -1,
        bottom: -1,
    },
    ellipsis: {
        width: 14,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0,
    },
    readyBounce: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
    },
});
