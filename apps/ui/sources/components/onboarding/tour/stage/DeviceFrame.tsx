import * as React from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';

import { stageVisualTokens } from './stageVisualTokens';

export type StageDevice = 'desktop' | 'phone';

type StageCanvasSize = Readonly<{
    width: number;
    height: number;
}>;

export type DeviceFrameLayout = Readonly<{
    logicalWidth: number;
    logicalHeight: number;
    scale: number;
    containerWidth: number;
    containerHeight: number;
    frameWidth: number;
    frameHeight: number;
}>;

export type DeviceFrameViewportGeometry = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
}>;

export const STAGE_DEVICE_CANVASES: Record<StageDevice, StageCanvasSize> = {
    desktop: {
        width: stageVisualTokens.desktopWindow.logicalWidth,
        height: stageVisualTokens.desktopWindow.logicalHeight,
    },
    phone: {
        width: stageVisualTokens.phoneFrame.logicalWidth,
        height: stageVisualTokens.phoneFrame.logicalHeight,
    },
} as const;

export type DeviceFrameProps = React.PropsWithChildren<Readonly<{
    device: StageDevice;
    onViewportGeometryChange?: (geometry: DeviceFrameViewportGeometry) => void;
    style?: ViewStyle;
    testID?: string;
}>>;

type DeviceFrameChromeMetrics = Readonly<{
    fixedWidth: number;
    fixedHeight: number;
}>;

type MeasuredSize = Readonly<{
    width: number;
    height: number;
}>;

type WebDeviceFrameNode = Readonly<{
    getBoundingClientRect: () => Readonly<{ width: number; height: number }>;
}>;

type ShadowStyle = ViewStyle & Readonly<{
    boxShadow?: string;
    backdropFilter?: string;
}>;

type WebEntranceStyle = ViewStyle & Readonly<{
    transitionDuration: string;
    transitionProperty: string;
    transitionTimingFunction: string;
}>;

const DEVICE_FRAME_CHROME: Record<StageDevice, DeviceFrameChromeMetrics> = {
    // Real app chrome (D20): the window has no title bar, so no vertical chrome
    // is subtracted — the app content is full-bleed inside the rounded shell.
    desktop: {
        fixedWidth: 0,
        fixedHeight: 0,
    },
    phone: {
        fixedWidth: 0,
        fixedHeight: 0,
    },
} as const;

function isPositiveFinite(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function readWebDeviceFrameSize(node: WebDeviceFrameNode): MeasuredSize | null {
    const rect = node.getBoundingClientRect();
    if (!isPositiveFinite(rect.width) || !isPositiveFinite(rect.height)) return null;
    return { width: rect.width, height: rect.height };
}

export function resolveWebDeviceFrameEntranceStyle(isMeasured: boolean): WebEntranceStyle {
    return {
        opacity: isMeasured ? 1 : 0,
        transform: [{ scale: isMeasured ? 1 : 0.98 }],
        transitionDuration: `${stageVisualTokens.motion.skipTransitionMs}ms`,
        transitionProperty: 'opacity, transform',
        transitionTimingFunction: 'ease-out',
    };
}

function resolveZeroDeviceFrameLayout(device: StageDevice): DeviceFrameLayout {
    const canvas = STAGE_DEVICE_CANVASES[device];
    return {
        logicalWidth: canvas.width,
        logicalHeight: canvas.height,
        scale: 0,
        containerWidth: 0,
        containerHeight: 0,
        frameWidth: 0,
        frameHeight: 0,
    };
}

export function resolveDeviceFrameLayout(
    device: StageDevice,
    containerWidth: number,
    containerHeight?: number,
): DeviceFrameLayout {
    const canvas = STAGE_DEVICE_CANVASES[device];
    const chrome = DEVICE_FRAME_CHROME[device];
    const normalizedWidth = isPositiveFinite(containerWidth) ? containerWidth : canvas.width;
    const hasBoundedHeight = isPositiveFinite(containerHeight);
    const normalizedHeight = hasBoundedHeight ? containerHeight : Number.POSITIVE_INFINITY;
    const availableWidth = resolveAvailableFrameWidth(device, normalizedWidth);
    const availableHeight = resolveAvailableFrameHeight(device, normalizedHeight, hasBoundedHeight);
    const maxViewportWidth = Math.max(0, availableWidth - chrome.fixedWidth);
    const maxViewportHeight = Math.max(0, availableHeight - chrome.fixedHeight);
    const scale = Math.min(
        maxViewportWidth / canvas.width,
        maxViewportHeight / canvas.height,
    );
    const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 0;
    const viewportWidth = canvas.width * normalizedScale;
    const viewportHeight = canvas.height * normalizedScale;

    return {
        logicalWidth: canvas.width,
        logicalHeight: canvas.height,
        scale: normalizedScale,
        containerWidth: viewportWidth,
        containerHeight: viewportHeight,
        frameWidth: viewportWidth + chrome.fixedWidth,
        frameHeight: viewportHeight + chrome.fixedHeight,
    };
}

export function resolveDeviceFrameViewportGeometry(
    device: StageDevice,
    containerWidth: number,
    containerHeight: number,
): DeviceFrameViewportGeometry {
    const layout = resolveDeviceFrameLayout(device, containerWidth, containerHeight);
    const opticalMarginTop = device === 'desktop'
        ? containerHeight * (stageVisualTokens.desktopWindow.opticalCenterYRatio - 0.5)
        : 0;
    return {
        x: (containerWidth - layout.frameWidth) / 2,
        y: (containerHeight - layout.frameHeight + opticalMarginTop) / 2,
        width: layout.containerWidth,
        height: layout.containerHeight,
        scale: layout.scale,
    };
}

function resolveAvailableFrameWidth(device: StageDevice, containerWidth: number): number {
    if (device === 'phone') {
        return containerWidth * (1 - stageVisualTokens.desktopWindow.minPaneMarginRatio * 2);
    }

    const preferredWidth = containerWidth * stageVisualTokens.desktopWindow.preferredWidthRatio;
    const minimumWidth = containerWidth * stageVisualTokens.desktopWindow.minWidthRatio;
    const maximumWidth = Math.min(
        containerWidth * stageVisualTokens.desktopWindow.maxWidthRatio,
        containerWidth * (1 - stageVisualTokens.desktopWindow.minPaneMarginRatio * 2),
    );

    return Math.min(Math.max(preferredWidth, minimumWidth), maximumWidth);
}

function resolveAvailableFrameHeight(
    device: StageDevice,
    containerHeight: number,
    hasBoundedHeight: boolean,
): number {
    if (!hasBoundedHeight) return Number.POSITIVE_INFINITY;
    if (device === 'phone') {
        return containerHeight * stageVisualTokens.phoneFrame.maxPaneHeightRatio;
    }
    return containerHeight * (1 - stageVisualTokens.desktopWindow.minPaneMarginRatio * 2);
}

export function DeviceFrame(props: DeviceFrameProps): React.ReactElement {
    const testID = props.testID ?? 'stage-device-frame';
    const { theme } = useUnistyles();
    const frameRef = React.useRef<View | null>(null);
    const [measuredSize, setMeasuredSize] = React.useState<MeasuredSize | null>(null);
    const layout = measuredSize
        ? resolveDeviceFrameLayout(props.device, measuredSize.width, measuredSize.height)
        : resolveZeroDeviceFrameLayout(props.device);
    const isMeasured = layout.scale > 0;
    const viewportGeometry = React.useMemo(() => (
        measuredSize
            ? resolveDeviceFrameViewportGeometry(props.device, measuredSize.width, measuredSize.height)
            : null
    ), [measuredSize, props.device]);
    const entrance = useSharedValue(0);

    React.useLayoutEffect(() => {
        if (!viewportGeometry || viewportGeometry.scale <= 0) return;
        props.onViewportGeometryChange?.(viewportGeometry);
    }, [props.onViewportGeometryChange, viewportGeometry]);

    React.useEffect(() => {
        entrance.value = withTiming(isMeasured ? 1 : 0, {
            duration: reanimatedMotionTokens.durationMs.base,
            easing: reanimatedMotionTokens.easing.standard,
        });
    }, [entrance, isMeasured]);

    const entranceStyle = useAnimatedStyle(() => ({
        opacity: entrance.value,
        transform: [{ scale: 0.98 + entrance.value * 0.02 }],
    }));
    const resolvedEntranceStyle = Platform.OS === 'web' ? null : entranceStyle;

    const commitMeasuredSize = React.useCallback(({ width, height }: MeasuredSize) => {
        if (!isPositiveFinite(width) || !isPositiveFinite(height)) return;
        setMeasuredSize((previousSize) => (
            previousSize?.width === width && previousSize.height === height
                ? previousSize
                : { width, height }
        ));
    }, []);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        commitMeasuredSize(event.nativeEvent.layout);
    }, [commitMeasuredSize]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !frameRef.current) return undefined;
        const node = frameRef.current as unknown as WebDeviceFrameNode;
        const measure = () => {
            const nextSize = readWebDeviceFrameSize(node);
            if (nextSize) commitMeasuredSize(nextSize);
        };
        measure();

        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(measure)
            : null;
        observer?.observe(frameRef.current as unknown as Element);
        window.addEventListener('resize', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
        };
    }, [commitMeasuredSize]);

    const isDark = Boolean((theme as { dark?: boolean }).dark);
    const shellStyle = props.device === 'desktop' ? styles.desktopShell : styles.phoneShell;
    const shellVisualStyle = props.device === 'desktop'
        ? buildDesktopShellVisualStyle(isDark)
        : buildPhoneShellVisualStyle(isDark);
    const viewportStyle = props.device === 'desktop' ? styles.desktopViewport : styles.phoneViewport;
    const shellSizeStyle = React.useMemo<ViewStyle>(() => ({
        height: layout.frameHeight,
        width: layout.frameWidth,
        ...(Platform.OS === 'web' ? resolveWebDeviceFrameEntranceStyle(isMeasured) : {}),
    }), [isMeasured, layout.frameHeight, layout.frameWidth]);
    const shellPositionStyle = React.useMemo<ViewStyle>(() => ({
        marginTop: measuredSize && props.device === 'desktop'
            ? measuredSize.height * (stageVisualTokens.desktopWindow.opticalCenterYRatio - 0.5)
            : 0,
    }), [measuredSize, props.device]);
    const ShellView = Platform.OS === 'web' ? View : Animated.View;

    return (
        <View
            ref={frameRef}
            testID={testID}
            onLayout={handleLayout}
            style={[styles.frame, props.style]}
        >
            <ShellView
                testID={`${testID}-shell`}
                style={[
                    styles.shell,
                    shellStyle,
                    shellVisualStyle,
                    shellSizeStyle,
                    shellPositionStyle,
                    resolvedEntranceStyle,
                ]}
            >
                {props.device === 'desktop' ? (
                    <>
                        {renderViewport({
                            children: props.children,
                            layout,
                            testID,
                            viewportStyle,
                        })}
                        {/* Decorative OS overlay controls: the real window draws
                            traffic lights over the top-left of the content (no
                            title bar), so we mirror that inset, not a fake bar. */}
                        <View
                            testID={`${testID}-traffic-overlay`}
                            pointerEvents="none"
                            style={styles.trafficOverlay}
                        >
                            <View testID={`${testID}-traffic-red`} style={[styles.trafficLight, styles.trafficRed]} />
                            <View testID={`${testID}-traffic-yellow`} style={[styles.trafficLight, styles.trafficYellow]} />
                            <View testID={`${testID}-traffic-green`} style={[styles.trafficLight, styles.trafficGreen]} />
                        </View>
                    </>
                ) : (
                    <>
                        <View testID={`${testID}-phone-button-left`} style={[styles.phoneButton, styles.phoneButtonLeft]} />
                        <View testID={`${testID}-phone-button-right`} style={[styles.phoneButton, styles.phoneButtonRight]} />
                        <View testID={`${testID}-phone-rail`} style={styles.phoneRail}>
                            <View testID={`${testID}-phone-bezel`} style={styles.phoneBezel}>
                                <View testID={`${testID}-phone-notch`} style={styles.phoneNotch} />
                                {renderViewport({
                                    children: props.children,
                                    layout,
                                    testID,
                                    viewportStyle,
                                })}
                            </View>
                        </View>
                    </>
                )}
            </ShellView>
        </View>
    );
}

function renderViewport(params: Readonly<{
    children: React.ReactNode;
    layout: DeviceFrameLayout;
    testID: string;
    viewportStyle: ViewStyle;
}>): React.ReactElement {
    return (
        <View
            testID={`${params.testID}-viewport`}
            style={[
                styles.viewport,
                params.viewportStyle,
                {
                    width: params.layout.containerWidth,
                    height: params.layout.containerHeight,
                },
            ]}
        >
            <View
                testID={`${params.testID}-canvas`}
                pointerEvents="none"
                style={[
                    styles.canvas,
                    {
                        width: params.layout.logicalWidth,
                        height: params.layout.logicalHeight,
                        transform: [{ scale: params.layout.scale }],
                    },
                ]}
            >
                {params.children}
            </View>
        </View>
    );
}

function buildDesktopShellVisualStyle(isDark: boolean): ShadowStyle {
    return {
        backgroundColor: isDark
            ? stageVisualTokens.desktopWindow.darkSurfaceColor
            : stageVisualTokens.desktopWindow.lightSurfaceColor,
        borderColor: isDark
            ? stageVisualTokens.desktopWindow.darkBorderColor
            : stageVisualTokens.desktopWindow.lightBorderColor,
        boxShadow: isDark
            ? stageVisualTokens.desktopWindow.darkShadow
            : stageVisualTokens.desktopWindow.lightShadow,
        backdropFilter: stageVisualTokens.desktopWindow.webBackdropFilter,
    };
}

function buildPhoneShellVisualStyle(isDark: boolean): ShadowStyle {
    return {
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        boxShadow: isDark
            ? '0 42px 92px -18px rgba(0,0,0,.62), 0 10px 28px rgba(0,0,0,.34)'
            : '0 42px 88px -20px rgba(30,20,10,.24), 0 8px 24px rgba(0,0,0,.12)',
    };
}

const styles = StyleSheet.create({
    frame: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        maxHeight: '100%',
        maxWidth: '100%',
        minHeight: 0,
        minWidth: 0,
        width: '100%',
    },
    shell: {
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
        overflow: 'hidden',
    },
    desktopShell: {
        borderCurve: 'continuous',
        borderRadius: stageVisualTokens.desktopWindow.radius,
        borderWidth: StyleSheet.hairlineWidth,
    },
    phoneShell: {
        borderCurve: 'continuous',
        borderRadius: stageVisualTokens.phoneFrame.outerRadius,
        overflow: 'visible',
        position: 'relative',
    },
    trafficOverlay: {
        flexDirection: 'row',
        gap: stageVisualTokens.desktopWindow.trafficLightGap,
        left: stageVisualTokens.desktopWindow.trafficLightInset,
        position: 'absolute',
        top: stageVisualTokens.desktopWindow.trafficLightOverlayTop,
        zIndex: 2,
    },
    trafficLight: {
        borderCurve: 'continuous',
        borderColor: stageVisualTokens.desktopWindow.trafficRingColor,
        borderRadius: stageVisualTokens.desktopWindow.trafficLightSize / 2,
        borderWidth: StyleSheet.hairlineWidth,
        height: stageVisualTokens.desktopWindow.trafficLightSize,
        width: stageVisualTokens.desktopWindow.trafficLightSize,
    },
    trafficRed: {
        backgroundColor: stageVisualTokens.desktopWindow.trafficRed,
    },
    trafficYellow: {
        backgroundColor: stageVisualTokens.desktopWindow.trafficYellow,
    },
    trafficGreen: {
        backgroundColor: stageVisualTokens.desktopWindow.trafficGreen,
    },
    viewport: {
        backgroundColor: '#fbfaf9',
        overflow: 'hidden',
    },
    desktopViewport: {
        borderCurve: 'continuous',
        borderRadius: stageVisualTokens.desktopWindow.radius,
    },
    phoneViewport: {
        borderCurve: 'continuous',
        borderRadius: stageVisualTokens.phoneFrame.screenRadius,
    },
    canvas: {
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        transformOrigin: 'top left',
    },
    phoneRail: {
        backgroundColor: stageVisualTokens.phoneFrame.bezelColor,
        borderColor: stageVisualTokens.phoneFrame.edgeColor,
        borderCurve: 'continuous',
        borderRadius: stageVisualTokens.phoneFrame.outerRadius,
        borderWidth: 1,
        height: '100%',
        width: '100%',
    },
    phoneBezel: {
        alignItems: 'center',
        backgroundColor: stageVisualTokens.phoneFrame.bezelColor,
        borderCurve: 'continuous',
        borderRadius: stageVisualTokens.phoneFrame.screenRadius,
        flex: 1,
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
    },
    phoneNotch: {
        alignSelf: 'center',
        backgroundColor: '#050608',
        borderCurve: 'continuous',
        borderRadius: 999,
        height: stageVisualTokens.phoneFrame.notchHeight,
        position: 'absolute',
        top: stageVisualTokens.phoneFrame.notchTop,
        width: stageVisualTokens.phoneFrame.notchWidth,
        zIndex: 2,
    },
    phoneButton: {
        backgroundColor: '#17181c',
        borderCurve: 'continuous',
        position: 'absolute',
        width: stageVisualTokens.phoneFrame.sideButtonWidth,
        zIndex: 1,
    },
    phoneButtonLeft: {
        borderBottomLeftRadius: 3,
        borderTopLeftRadius: 3,
        height: 58,
        left: -3,
        top: 112,
    },
    phoneButtonRight: {
        borderBottomRightRadius: 3,
        borderTopRightRadius: 3,
        height: 78,
        right: -3,
        top: 156,
    },
});
