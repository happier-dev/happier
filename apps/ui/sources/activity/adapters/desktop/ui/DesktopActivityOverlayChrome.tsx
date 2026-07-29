import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { UnistylesThemes } from 'react-native-unistyles';
import Svg, { Path } from 'react-native-svg';

import { interpolateDesktopOverlayCorners } from '../motion/desktopOverlayCornerInterpolation';
import type { DesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';

type Theme = UnistylesThemes[keyof UnistylesThemes];
type ChromeTone = 'collapsed' | 'expanded' | 'row';
type InteriorSurfaceKind = 'action' | 'badge' | 'card';

export const DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR = 'rgb(5, 5, 5)';

const notchIntegratedChromeRadii = {
    collapsed: {
        borderTopLeftRadius: interpolateDesktopOverlayCorners(0).topRadius,
        borderTopRightRadius: interpolateDesktopOverlayCorners(0).topRadius,
        borderBottomLeftRadius: interpolateDesktopOverlayCorners(0).bottomRadius,
        borderBottomRightRadius: interpolateDesktopOverlayCorners(0).bottomRadius,
    },
    expanded: {
        borderTopLeftRadius: interpolateDesktopOverlayCorners(1).topRadius,
        borderTopRightRadius: interpolateDesktopOverlayCorners(1).topRadius,
        borderBottomLeftRadius: interpolateDesktopOverlayCorners(1).bottomRadius,
        borderBottomRightRadius: interpolateDesktopOverlayCorners(1).bottomRadius,
    },
    row: {
        borderTopLeftRadius: 10,
        borderTopRightRadius: 10,
        borderBottomLeftRadius: 14,
        borderBottomRightRadius: 14,
    },
} as const satisfies Record<ChromeTone, Readonly<Record<string, number>>>;

function resolveNotchIntegratedChromeRadii(openProgress: number): Readonly<Record<string, number>> {
    const corners = interpolateDesktopOverlayCorners(openProgress);
    return {
        borderTopLeftRadius: corners.topRadius,
        borderTopRightRadius: corners.topRadius,
        borderBottomLeftRadius: corners.bottomRadius,
        borderBottomRightRadius: corners.bottomRadius,
    };
}

function formatOpaqueColorWithAlpha(baseColor: string, alpha: number): string {
    const normalizedAlpha = Math.max(0, Math.min(1, alpha));
    const rgbaMatch = baseColor.match(
        /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)$/,
    );
    if (rgbaMatch) {
        const [, red, green, blue] = rgbaMatch;
        return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
    }

    const hexMatch = baseColor.match(/^#([0-9a-fA-F]{3,8})$/);
    if (!hexMatch) {
        return baseColor;
    }

    const hex = hexMatch[1];
    const expand = (value: string): string => (value.length === 1 ? `${value}${value}` : value);
    const red = Number.parseInt(expand(hex.slice(0, hex.length >= 6 ? 2 : 1)), 16);
    const green = Number.parseInt(expand(hex.slice(hex.length >= 6 ? 2 : 1, hex.length >= 6 ? 4 : 2)), 16);
    const blue = Number.parseInt(expand(hex.slice(hex.length >= 6 ? 4 : 2, hex.length >= 6 ? 6 : 3)), 16);

    return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
}

function resolveChromeRadii(
    visualMode: DesktopActivityOverlayVisualMode,
    tone: ChromeTone,
    openProgress?: number,
): Readonly<Record<string, number>> {
    if (visualMode === 'notch_integrated' && tone !== 'row' && typeof openProgress === 'number') {
        return resolveNotchIntegratedChromeRadii(openProgress);
    }

    if (tone === 'collapsed') {
        return visualMode === 'notch_integrated'
            ? notchIntegratedChromeRadii.collapsed
            : {
                borderRadius: 24,
            };
    }

    if (tone === 'expanded') {
        return visualMode === 'notch_integrated'
            ? notchIntegratedChromeRadii.expanded
            : {
                borderRadius: 22,
            };
    }

    return visualMode === 'notch_integrated'
        ? notchIntegratedChromeRadii.row
        : {
            borderRadius: 14,
        };
}

function resolveChromeSurfaceAlpha(
    visualMode: DesktopActivityOverlayVisualMode,
    tone: ChromeTone,
): number {
    if (visualMode === 'notch_integrated') {
        if (tone === 'collapsed') return 0.992;
        if (tone === 'expanded') return 0.985;
        return 0.972;
    }

    if (tone === 'collapsed') return 0.965;
    if (tone === 'expanded') return 0.952;
    return 0.938;
}

function resolveInteriorSurfaceAlpha(
    visualMode: DesktopActivityOverlayVisualMode,
    kind: InteriorSurfaceKind,
): number {
    if (visualMode === 'notch_integrated') {
        if (kind === 'card') return 0.958;
        return kind === 'action' ? 0.985 : 0.97;
    }

    if (kind === 'card') return 0.94;
    return kind === 'action' ? 0.97 : 0.955;
}

function resolveChromeBackgroundColor(
    _theme: Theme,
    params: Readonly<{
        visualMode: DesktopActivityOverlayVisualMode;
        tone: ChromeTone;
    }>,
): string {
    return formatOpaqueColorWithAlpha(
        DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR,
        resolveChromeSurfaceAlpha(params.visualMode, params.tone),
    );
}

function resolveNotchGeometry(tone: ChromeTone, openProgress?: number): Readonly<{
    topCornerRadius: number;
    bottomCornerRadius: number;
}> {
    if (tone !== 'row' && typeof openProgress === 'number') {
        const corners = interpolateDesktopOverlayCorners(openProgress);
        return {
            topCornerRadius: corners.topRadius,
            bottomCornerRadius: corners.bottomRadius,
        };
    }
    if (tone === 'collapsed') {
        const corners = interpolateDesktopOverlayCorners(0);
        return {
            topCornerRadius: corners.topRadius,
            bottomCornerRadius: corners.bottomRadius,
        };
    }

    if (tone === 'expanded') {
        const corners = interpolateDesktopOverlayCorners(1);
        return {
            topCornerRadius: corners.topRadius,
            bottomCornerRadius: corners.bottomRadius,
        };
    }

    return {
        topCornerRadius: 10,
        bottomCornerRadius: 14,
    };
}

function buildDesktopActivityOverlayNotchPath(
    width: number,
    height: number,
    tone: ChromeTone,
    openProgress?: number,
): string {
    const normalizedWidth = Math.max(1, width);
    const normalizedHeight = Math.max(1, height);
    const geometry = resolveNotchGeometry(tone, openProgress);
    const topCornerRadius = Math.min(geometry.topCornerRadius, normalizedWidth / 4, normalizedHeight / 2);
    const bottomCornerRadius = Math.min(geometry.bottomCornerRadius, normalizedWidth / 4, normalizedHeight / 2);

    return [
        `M 0 0`,
        `Q ${topCornerRadius} 0 ${topCornerRadius} ${topCornerRadius}`,
        `L ${topCornerRadius} ${normalizedHeight - bottomCornerRadius}`,
        `Q ${topCornerRadius} ${normalizedHeight} ${topCornerRadius + bottomCornerRadius} ${normalizedHeight}`,
        `L ${normalizedWidth - topCornerRadius - bottomCornerRadius} ${normalizedHeight}`,
        `Q ${normalizedWidth - topCornerRadius} ${normalizedHeight} ${normalizedWidth - topCornerRadius} ${normalizedHeight - bottomCornerRadius}`,
        `L ${normalizedWidth - topCornerRadius} ${topCornerRadius}`,
        `Q ${normalizedWidth - topCornerRadius} 0 ${normalizedWidth} 0`,
        `L 0 0`,
        'Z',
    ].join(' ');
}

export function createDesktopActivityOverlayChromeStyle(
    theme: Theme,
    params: Readonly<{
        visualMode: DesktopActivityOverlayVisualMode;
        tone: ChromeTone;
        openProgress?: number;
    }>,
): Record<string, unknown> {
    const backgroundColor = params.visualMode === 'notch_integrated'
        ? 'transparent'
        : resolveChromeBackgroundColor(theme, params);

    return {
        borderWidth: 0,
        borderColor: 'transparent',
        backgroundColor,
        ...resolveChromeRadii(params.visualMode, params.tone, params.openProgress),
    };
}

export function DesktopActivityOverlayChromeBackdrop(props: Readonly<{
    theme: Theme;
    visualMode: DesktopActivityOverlayVisualMode;
    tone: ChromeTone;
    width: number;
    height: number;
    openProgress?: number;
}>): React.ReactElement | null {
    if (props.visualMode !== 'notch_integrated') {
        return null;
    }

    if (!Number.isFinite(props.width) || !Number.isFinite(props.height) || props.width <= 0 || props.height <= 0) {
        return null;
    }

    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Svg width="100%" height="100%" viewBox={`0 0 ${props.width} ${props.height}`}>
                <Path
                    d={buildDesktopActivityOverlayNotchPath(props.width, props.height, props.tone, props.openProgress)}
                    fill={resolveChromeBackgroundColor(props.theme, props)}
                />
            </Svg>
        </View>
    );
}

export function createDesktopActivityOverlayInteriorSurfaceStyle(
    _theme: Theme,
    params: Readonly<{
        visualMode: DesktopActivityOverlayVisualMode;
        kind: InteriorSurfaceKind;
    }>,
): Record<string, unknown> {
    return {
        borderWidth: 0,
        borderColor: 'transparent',
        backgroundColor: formatOpaqueColorWithAlpha(
            DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR,
            resolveInteriorSurfaceAlpha(params.visualMode, params.kind),
        ),
        borderRadius: params.kind === 'badge' ? 999 : (params.kind === 'card' ? 18 : 10),
    };
}

export function DesktopActivityOverlayChromeHighlights(props: Readonly<{
    theme: Theme;
    visualMode: DesktopActivityOverlayVisualMode;
    tone: ChromeTone;
}>): React.ReactElement | null {
    if (props.visualMode === 'notch_integrated') {
        return null;
    }

    const toneStyle = chromeHighlightStyles[props.visualMode][props.tone];

    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View
                style={[
                    styles.topSeam,
                    toneStyle.topSeam,
                    { backgroundColor: DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR },
                ]}
            />
            <View
                style={[
                    styles.topGlow,
                    toneStyle.topGlow,
                    { backgroundColor: props.theme.colors.overlay.foreground },
                ]}
            />
            <View
                style={[
                    styles.bottomShade,
                    toneStyle.bottomShade,
                    { backgroundColor: DESKTOP_ACTIVITY_OVERLAY_CHROME_BASE_COLOR },
                ]}
            />
            <View
                style={[
                    styles.innerRim,
                    toneStyle.innerRim,
                    { borderColor: props.theme.colors.overlay.foreground },
                ]}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    topSeam: {
        position: 'absolute',
        left: 10,
        right: 10,
        top: 0,
        height: 1,
        opacity: 0.96,
    },
    topGlow: {
        position: 'absolute',
        left: 10,
        right: 10,
        top: 0,
        borderRadius: 999,
        opacity: 0.012,
    },
    bottomShade: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        opacity: 0.02,
    },
    innerRim: {
        ...StyleSheet.absoluteFillObject,
        borderWidth: StyleSheet.hairlineWidth,
        opacity: 0.01,
    },
});

const chromeHighlightStyles: Record<
    DesktopActivityOverlayVisualMode,
    Record<ChromeTone, Record<'topSeam' | 'topGlow' | 'bottomShade' | 'innerRim', object>>
> = {
    notch_integrated: {
        collapsed: {
            topSeam: {
                left: 18,
                right: 18,
            },
            topGlow: {
                height: 5,
                top: 1,
                left: 18,
                right: 18,
            },
            bottomShade: {
                height: 8,
                borderBottomLeftRadius: 18,
                borderBottomRightRadius: 18,
            },
            innerRim: {
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                borderBottomLeftRadius: 14,
                borderBottomRightRadius: 14,
            },
        },
        expanded: {
            topSeam: {
                left: 18,
                right: 18,
            },
            topGlow: {
                height: 6,
                top: 2,
                left: 18,
                right: 18,
            },
            bottomShade: {
                height: 10,
                borderBottomLeftRadius: 28,
                borderBottomRightRadius: 28,
            },
            innerRim: {
                borderTopLeftRadius: 19,
                borderTopRightRadius: 19,
                borderBottomLeftRadius: 24,
                borderBottomRightRadius: 24,
            },
        },
        row: {
            topSeam: {
                left: 14,
                right: 14,
            },
            topGlow: {
                height: 5,
                top: 1,
                left: 12,
                right: 12,
            },
            bottomShade: {
                height: 8,
                borderBottomLeftRadius: 16,
                borderBottomRightRadius: 16,
            },
            innerRim: {
                borderTopLeftRadius: 12,
                borderTopRightRadius: 12,
                borderBottomLeftRadius: 16,
                borderBottomRightRadius: 16,
            },
        },
    },
    floating_overlay: {
        collapsed: {
            topSeam: {
                left: 12,
                right: 12,
            },
            topGlow: {
                height: 8,
                top: 2,
                left: 10,
                right: 10,
            },
            bottomShade: {
                height: 12,
                borderBottomLeftRadius: 24,
                borderBottomRightRadius: 24,
            },
            innerRim: {
                borderRadius: 24,
            },
        },
        expanded: {
            topSeam: {
                left: 12,
                right: 12,
            },
            topGlow: {
                height: 9,
                top: 2,
                left: 10,
                right: 10,
            },
            bottomShade: {
                height: 14,
                borderBottomLeftRadius: 22,
                borderBottomRightRadius: 22,
            },
            innerRim: {
                borderRadius: 22,
            },
        },
        row: {
            topSeam: {
                left: 10,
                right: 10,
            },
            topGlow: {
                height: 7,
                top: 2,
                left: 8,
                right: 8,
            },
            bottomShade: {
                height: 10,
                borderBottomLeftRadius: 14,
                borderBottomRightRadius: 14,
            },
            innerRim: {
                borderRadius: 14,
            },
        },
    },
};
