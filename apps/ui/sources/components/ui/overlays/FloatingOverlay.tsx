import * as React from 'react';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import {
    Platform,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type ScrollView,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades, type ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { shadowLevelStyle } from '@/shadowElevation';
import {
    resolveThemeSurfaceBorderStyle,
    resolveThemeSurfaceChromeStyle,
    type ThemeSurfaceChromeStyle,
} from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';

import { FLOATING_OVERLAY_METRICS } from './floatingOverlayMetrics';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';

const OVERLAY_BORDER_RADIUS = FLOATING_OVERLAY_METRICS.radiusPx;

// A sheet already owns its glass and corners. Keep the same scrolling content
// without nesting a second floating card inside the shared modal surface.
export const FloatingOverlaySheetContext = React.createContext(false);

function extractSurfaceStyle(chromeStyle: ThemeSurfaceChromeStyle) {
    return {
        borderColor: chromeStyle.borderColor,
        borderWidth: chromeStyle.borderWidth,
        borderTopColor: chromeStyle.borderTopColor,
        borderTopWidth: chromeStyle.borderTopWidth,
        borderBottomColor: chromeStyle.borderBottomColor,
        borderBottomWidth: chromeStyle.borderBottomWidth,
    };
}

const stylesheet = StyleSheet.create((theme) => {
    // Every floating surface stands on the floating hairline (`border.modal`) and its raised edge; the
    // shadow only grounds it (menus at the menu step, popovers at the popover step). In-flow sheets
    // keep `border.surface`, which a light theme leaves transparent.
    const themedSurfaceChromeStyle = resolveThemeSurfaceChromeStyle({
        borderColor: theme.colors.border.modal,
        edge: resolveThemeRaisedEdge(theme, 'modal'),
        rim: surfaceUsesRim('floating', theme.dark),
        shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[2]),
    });

    return {
        modalShadowFrame: {
            borderRadius: OVERLAY_BORDER_RADIUS,
            backgroundColor: 'transparent',
            ...shadowLevelStyle(theme.colors.shadowLevels[4]),
        },
        modalClipSurface: {
            borderRadius: OVERLAY_BORDER_RADIUS,
            overflow: 'hidden',
            ...resolveThemeSurfaceBorderStyle({
                borderColor: theme.colors.border.modal,
                edge: resolveThemeRaisedEdge(theme, 'modal'),
                rim: surfaceUsesRim('floating', theme.dark),
            }),
        },
        themedSurfaceShadowFrame: {
            borderRadius: OVERLAY_BORDER_RADIUS,
            backgroundColor: 'transparent',
            ...shadowLevelStyle(theme.colors.shadowLevels[2]),
        },
        themedSurfaceClip: {
            borderRadius: OVERLAY_BORDER_RADIUS,
            overflow: 'hidden',
            ...extractSurfaceStyle(themedSurfaceChromeStyle),
        },
    };
});

export type FloatingOverlayEdgeFades =
    | boolean
    | Readonly<{
            top?: boolean;
            bottom?: boolean;
            left?: boolean;
            right?: boolean;
            /** Gradient size in px (default 18). */
            size?: number;
        }>;

export type FloatingOverlayArrow =
    | boolean
    | Readonly<{
            /**
             * The popover placement relative to its anchor. The arrow is rendered on the opposite
             * edge (closest to the anchor), so `placement="bottom"` results in a top arrow.
             */
            placement: 'top' | 'bottom' | 'left' | 'right';
            /** Square size in px (default 12). */
            size?: number;
        }>;

interface FloatingOverlayProps {
    children: React.ReactNode;
    /** Fixed menu chrome; only the results between these slots scroll. */
    header?: React.ReactNode;
    footer?: React.ReactNode;
    maxHeight?: number;
    scrollEnabled?: boolean;
    showScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
    edgeFades?: FloatingOverlayEdgeFades;
    containerStyle?: StyleProp<ViewStyle>;
    scrollViewStyle?: StyleProp<ViewStyle>;
    /**
     * Optional subtle chevrons (up/down/left/right) that show when more content
     * exists beyond the current scroll position. Defaults to false.
     */
    edgeIndicators?: boolean | Readonly<{ size?: number; opacity?: number }>;
    /** Optional arrow that points back to the anchor (useful for context menus). */
    arrow?: FloatingOverlayArrow;
    /** Defaults to legacy modal chrome; bounded popovers can opt into theme surface chrome. */
    surfaceChrome?: 'modal' | 'theme';
    /**
     * Initial visibility for scroll edge fades before measurement.
     * Useful for optimistic trailing-edge fades (e.g., bottom: true for lists
     * that typically have more content below).
     */
    initialVisibility?: Partial<ScrollEdgeVisibility>;
    scrollViewRef?: React.Ref<ScrollView>;
    onScrollViewLayout?: (event: LayoutChangeEvent) => void;
    onScrollViewContentSizeChange?: (width: number, height: number) => void;
    onScrollViewScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

export const FloatingOverlay = React.memo((props: FloatingOverlayProps) => {
    const insideSheet = React.useContext(FloatingOverlaySheetContext);
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const fadeColor = useGlassSurfaceColor(theme.colors.surface.base, 'floating', false);
    const { 
        children, 
        maxHeight = 240, 
        scrollEnabled = true,
        showScrollIndicator = false, 
        keyboardShouldPersistTaps = 'handled',
        edgeFades = false,
        edgeIndicators = false,
        arrow = false,
        surfaceChrome = 'modal',
        containerStyle,
        scrollViewStyle,
        scrollViewRef,
        onScrollViewLayout,
        onScrollViewContentSizeChange,
        onScrollViewScroll,
    } = props;

    const fadeCfg = React.useMemo(() => {
        if (!edgeFades) return null;
        if (edgeFades === true) return { top: true, bottom: true, size: 18 } as const;
        return {
            top: edgeFades.top ?? false,
            bottom: edgeFades.bottom ?? false,
            left: edgeFades.left ?? false,
            right: edgeFades.right ?? false,
            size: typeof edgeFades.size === 'number' ? edgeFades.size : 18,
        };
    }, [edgeFades]);

    const indicatorCfg = React.useMemo(() => {
        if (!edgeIndicators) return null;
        if (edgeIndicators === true) return { size: 14, opacity: 0.35 } as const;
        return {
            size: typeof edgeIndicators.size === 'number' ? edgeIndicators.size : 14,
            opacity: typeof edgeIndicators.opacity === 'number' ? edgeIndicators.opacity : 0.35,
        };
    }, [edgeIndicators]);

    const fades = useScrollEdgeFades({
        enabledEdges: {
            top: scrollEnabled && (Boolean(fadeCfg?.top) || Boolean(indicatorCfg)),
            bottom: scrollEnabled && (Boolean(fadeCfg?.bottom) || Boolean(indicatorCfg)),
            left: scrollEnabled && Boolean(fadeCfg?.left),
            right: scrollEnabled && Boolean(fadeCfg?.right),
        },
        overflowThreshold: 1,
        edgeThreshold: 1,
        initialVisibility: props.initialVisibility,
    });

    const arrowCfg = React.useMemo(() => {
        if (!arrow) return null;
        if (arrow === true) return { placement: 'bottom' as const, size: 12 } as const;
        return {
            placement: arrow.placement,
            size: typeof arrow.size === 'number' ? arrow.size : 12,
        };
    }, [arrow]);

    const arrowSide = React.useMemo(() => {
        const placement = arrowCfg?.placement;
        if (!placement) return null;
        switch (placement) {
            case 'top':
                return 'bottom';
            case 'bottom':
                return 'top';
            case 'left':
                return 'right';
            case 'right':
                return 'left';
        }
    }, [arrowCfg?.placement]);

    const content = scrollEnabled ? (
        <Animated.ScrollView
            ref={scrollViewRef}
            style={[{ maxHeight, flexShrink: 1 }, scrollViewStyle]}
            keyboardShouldPersistTaps={keyboardShouldPersistTaps}
            showsVerticalScrollIndicator={showScrollIndicator}
            scrollEventThrottle={32}
            onLayout={(event) => {
                if (fadeCfg || indicatorCfg) fades.onViewportLayout(event);
                onScrollViewLayout?.(event);
            }}
            onContentSizeChange={(width, height) => {
                if (fadeCfg || indicatorCfg) fades.onContentSizeChange(width, height);
                onScrollViewContentSizeChange?.(width, height);
            }}
            onScroll={(event) => {
                if (fadeCfg || indicatorCfg) fades.onScroll(event);
                onScrollViewScroll?.(event);
            }}
            onMomentumScrollEnd={(event) => {
                if (fadeCfg || indicatorCfg) fades.onMomentumScrollEnd(event);
                onScrollViewScroll?.(event);
            }}
        >
            {children}
        </Animated.ScrollView>
    ) : (
        <Animated.View style={[{ maxHeight }, scrollViewStyle]}>
            {children}
        </Animated.View>
    );

    const surfaceContent = <>
        {props.header}
        {content}
        {props.footer}
        {scrollEnabled && fadeCfg ? (
            <ScrollEdgeFades color={fadeColor} size={fadeCfg.size} edges={fades.visibility} />
        ) : null}
        {scrollEnabled && indicatorCfg ? (
            <ScrollEdgeIndicators
                edges={fades.visibility}
                color={theme.colors.text.secondary}
                size={indicatorCfg.size}
                opacity={indicatorCfg.opacity}
            />
        ) : null}
    </>;

    if (insideSheet) {
        return <ListPresentationProvider value="grouped">
            <Animated.View style={[{ maxHeight, flexShrink: 1, minHeight: 0 }, containerStyle]}>
                <FloatingOverlaySheetContext.Provider value={false}>
                    {surfaceContent}
                </FloatingOverlaySheetContext.Provider>
            </Animated.View>
        </ListPresentationProvider>;
    }

    const overlay = (
        <Animated.View style={[
            surfaceChrome === 'theme' ? styles.themedSurfaceShadowFrame : styles.modalShadowFrame,
            { maxHeight },
            containerStyle,
        ]}>
            <GlassSurface surfaceGroup="floating" style={[
                surfaceChrome === 'theme' ? styles.themedSurfaceClip : styles.modalClipSurface,
                { maxHeight },
            ]}>
                {surfaceContent}
                <SurfaceRim role="floating" radius={OVERLAY_BORDER_RADIUS} border="modal" />
            </GlassSurface>
        </Animated.View>
    );

    if (!arrowCfg || !arrowSide) return <ListPresentationProvider value="grouped">{overlay}</ListPresentationProvider>;

    const arrowSize = arrowCfg.size;
    const protrusion = arrowSize / 2;

    const arrowBoxStyle: ViewStyle & { boxShadow?: string } = {
        width: arrowSize,
        height: arrowSize,
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.base, 'floating'),
        transform: [{ rotate: '45deg' as const }],
    };

    // The arrow wears its surface's hairline. Its sides are diagonals, so it stays flat (no raised
    // edge). RN-web is inconsistent with shadow props on transformed views, so web uses CSS box-shadow.
    Object.assign(arrowBoxStyle, resolveThemeSurfaceChromeStyle({
        borderColor: theme.colors.border.modal,
        shadowStyle: Platform.OS === 'web'
            ? { boxShadow: theme.colors.shadowPopoverArrowBoxShadow }
            : shadowLevelStyle(theme.colors.shadowLevels[4]),
    }));

    const arrowWrapperStyle: ViewStyle = {
        position: 'absolute',
        pointerEvents: 'none',
    };

    switch (arrowSide) {
        case 'top':
            Object.assign(arrowWrapperStyle, {
                top: -protrusion,
                left: 0,
                right: 0,
                height: arrowSize,
                alignItems: 'center',
            });
            break;
        case 'bottom':
            Object.assign(arrowWrapperStyle, {
                bottom: -protrusion,
                left: 0,
                right: 0,
                height: arrowSize,
                alignItems: 'center',
            });
            break;
        case 'left':
            Object.assign(arrowWrapperStyle, {
                left: -protrusion,
                top: 0,
                bottom: 0,
                width: arrowSize,
                justifyContent: 'center',
            });
            break;
        case 'right':
            Object.assign(arrowWrapperStyle, {
                right: -protrusion,
                top: 0,
                bottom: 0,
                width: arrowSize,
                justifyContent: 'center',
            });
            break;
    }

    return (
        <Animated.View style={{ position: 'relative' }}>
            <View testID="floating-overlay-arrow" style={arrowWrapperStyle}>
                <View style={arrowBoxStyle} />
            </View>
            <ListPresentationProvider value="grouped">{overlay}</ListPresentationProvider>
        </Animated.View>
    );
});
