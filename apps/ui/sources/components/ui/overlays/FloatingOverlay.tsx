import type { SurfaceAddress } from '@happier-dev/plugin-ui';
import * as React from 'react';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PopoverScrollSourceProvider } from '@/components/ui/popover/PopoverScrollSource';
import {
    Platform,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type ScrollView,
    type ScrollViewProps,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { nonScrollingClipStyle } from '@/components/ui/surfaces/nonScrollingClip';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades, type ScrollEdgeVisibility } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { shadowLevelStyle } from '@/shadowElevation';
import {
    resolveThemeSurfaceBorderStyle,
    resolveThemeSurfaceChromeStyle,
    type ThemeSurfaceChromeStyle,
} from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { PhonePushedViewContext, type PhonePushedView } from '@/components/ui/popover/phonePushedView';
import { ModalBackButton } from '@/modal/components/card/ModalBackButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { FLOATING_OVERLAY_METRICS } from './floatingOverlayMetrics';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { useGlassSurfaceBackdropTone, useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';
import { HappierListRowFollowedContext, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
import { SurfaceFreshnessOnSheetProvider } from '@/components/ui/surfaces/SurfaceFreshnessLine';

const OVERLAY_BORDER_RADIUS = FLOATING_OVERLAY_METRICS.radiusPx;
// Shrinks with the scroller under the surface's height cap and positions its edge cues.
const SCROLL_VIEWPORT_FRAME_STYLE: ViewStyle = { position: 'relative', flexShrink: 1, minHeight: 0 };

// A sheet already owns its material and corners. Keep the same scrolling content
// without nesting a second floating card inside the shared modal surface.
export const FloatingOverlaySheetContext = React.createContext(false);

// A phone panel (`Popover` `phonePresentation="panel"`) spans the screen like the sheet it replaced (owner R2,
// 2026-11-09): it wears the sheet's panel coat, so the page under it never reads through its rows.
export const FloatingOverlayPhonePanelContext = React.createContext(false);

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
            ...nonScrollingClipStyle(),
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
            ...nonScrollingClipStyle(),
            ...extractSurfaceStyle(themedSurfaceChromeStyle),
        },
    };
});

const pushedBackStyles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s4,
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
}));

/** A pushed view's way back to the popover it replaced, at the top of its floating surface. */
function PushedViewBackRow(props: Readonly<{ view: PhonePushedView }>) {
    const styles = pushedBackStyles;
    return (
        <View style={styles.row}>
            <ModalBackButton testID="popover-push.back" onPress={props.view.back} />
            {props.view.title ? <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{props.view.title}</Text> : null}
        </View>
    );
}

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

/** A recycler can own the scroll viewport while the floating surface keeps its chrome and edge cues. */
export type FloatingOverlayScrollProps = Pick<ScrollViewProps,
    'style' | 'keyboardShouldPersistTaps' | 'showsVerticalScrollIndicator' | 'scrollEventThrottle'
    | 'onLayout' | 'onContentSizeChange' | 'onScroll' | 'onMomentumScrollEnd'>;

interface FloatingOverlayProps {
    themeSurface?: SurfaceAddress;
    children: React.ReactNode;
    renderScrollContent?: (scroll: FloatingOverlayScrollProps) => React.ReactNode;
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
    /** Selects the existing border/shadow chrome; both variants follow the floating material. */
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
    const phonePanel = React.useContext(FloatingOverlayPhonePanelContext);
    const pushedView = React.useContext(PhonePushedViewContext);
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const backdropTone = useGlassSurfaceBackdropTone('floating', theme.colors.edge.floatingFill);
    const glassFadeColor = useGlassSurfaceColor(theme.colors.edge.floatingFill, 'floating', false);
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
    const fadeColor = glassFadeColor;
    const containerBackground = readSurfaceStyleProperty(containerStyle, 'backgroundColor');
    const ownContainerColor = useGlassSurfaceColor(typeof containerBackground === 'string' ? containerBackground : 'transparent', 'floating');
    const resolveContainingColor = useHappierMaterialColorResolver();
    const containerPaint = typeof containerBackground === 'string' ? { backgroundColor: insideSheet
        ? resolveContainingColor(containerBackground, 'transparent') : ownContainerColor } : null;

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

    // The overlay's own scroller is the scroll source of what it holds: a list or menu inside it follows and drives
    // this scroller, never the page behind the overlay.
    const scrollerRef = React.useRef<ScrollView | null>(null);
    const setScroller = React.useCallback((node: ScrollView | null) => {
        scrollerRef.current = node;
        if (typeof scrollViewRef === 'function') scrollViewRef(node);
        else if (scrollViewRef) (scrollViewRef as React.MutableRefObject<ScrollView | null>).current = node;
    }, [scrollViewRef]);
    // Its scroll activity too: a collection windowed "in its page" inside the overlay windows in this scroller,
    // never in the page behind it, which stays still while the overlay scrolls (SWEEP-STORE-OPS-164: the examples
    // picker mounted 16 of 21 cards and scrolling it never brought the rest).
    const scrollActivity = React.useMemo(() => createScrollViewNearViewportTracker(scrollerRef, false), []);
    // On the web the floating surface is glass, so a painted fade has no colour to cover a row with: the rows
    // themselves fade out at a scrolled-past edge of the viewport instead. Native keeps the painted fades.
    const webEdgeMask = React.useMemo(() => (Platform.OS === 'web' && fadeCfg ? resolveVerticalScrollEdgeMaskStyle({
        top: fadeCfg.top && fades.visibility.top,
        bottom: fadeCfg.bottom && fades.visibility.bottom,
        left: false,
        right: false,
    }, { fadeSize: fadeCfg.size }) : null), [fadeCfg, fades.visibility]);
    const scrollProps: FloatingOverlayScrollProps = {
            style: [{ maxHeight, flexShrink: 1 }, scrollViewStyle, webEdgeMask],
            keyboardShouldPersistTaps,
            showsVerticalScrollIndicator: showScrollIndicator,
            scrollEventThrottle: 32,
            onLayout: (event) => {
                if (fadeCfg || indicatorCfg) fades.onViewportLayout(event);
                onScrollViewLayout?.(event);
            },
            onContentSizeChange: (width, height) => {
                if (fadeCfg || indicatorCfg) fades.onContentSizeChange(width, height);
                onScrollViewContentSizeChange?.(width, height);
            },
            onScroll: (event) => {
                if (fadeCfg || indicatorCfg) fades.onScroll(event);
                onScrollViewScroll?.(event);
            },
            onMomentumScrollEnd: (event) => {
                if (fadeCfg || indicatorCfg) fades.onMomentumScrollEnd(event);
                onScrollViewScroll?.(event);
            },
    };
    const content = scrollEnabled ? (
        <PopoverScrollSourceProvider scrollSourceRef={scrollerRef}>
            {props.renderScrollContent ? props.renderScrollContent(scrollProps) : (
                <Animated.ScrollView {...scrollProps} ref={setScroller}
                    onLayout={(event) => { scrollProps.onLayout?.(event); scrollActivity.onLayout(event); }}
                    onContentSizeChange={(width, height) => {
                        scrollProps.onContentSizeChange?.(width, height);
                        scrollActivity.onContentSizeChange(width, height);
                    }}
                    onScroll={(event) => { scrollProps.onScroll?.(event); scrollActivity.onScroll(event); }}>
                    <PluginUiScrollActivityProvider tracker={scrollActivity}>{children}</PluginUiScrollActivityProvider>
                </Animated.ScrollView>
            )}
        </PopoverScrollSourceProvider>
    ) : (
        <Animated.View style={[{ maxHeight }, scrollViewStyle]}>
            {children}
        </Animated.View>
    );

    // The floating surface is the sheet its content sits on: a freshness line inside is one plain line, never a strip.
    // A view pushed inside a phone popover leads with its way back; surfaces nested in it don't repeat it.
    // The edge fades and indicators frame the scroll viewport itself, so a pinned header (a search field) and footer
    // stay clear of them and a row scrolled past either edge fades out at the viewport's edge instead of being cut there.
    // A floating surface is not a row of the list it opened from: its rows state their own order, or none.
    const surfaceContent = <HappierListRowFollowedContext.Provider value={null}><SurfaceFreshnessOnSheetProvider>
        {pushedView ? <PushedViewBackRow view={pushedView} /> : null}
        {props.header}
        <View style={SCROLL_VIEWPORT_FRAME_STYLE}>
            <PhonePushedViewContext.Provider value={null}>{content}</PhonePushedViewContext.Provider>
            {scrollEnabled && fadeCfg && Platform.OS !== 'web' ? (
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
        </View>
        {props.footer}
    </SurfaceFreshnessOnSheetProvider></HappierListRowFollowedContext.Provider>;

    // One tree whichever way the surface is presented: a popover body kept mounted while it moves from an anchored
    // popover into a phone sheet and back keeps its rows (typed text, a picked source). Only props change: inside a
    // sheet the surface paints nothing of its own (the sheet is the surface) and draws no arrow.
    const arrowNode = !insideSheet && arrowCfg && arrowSide ? renderFloatingOverlayArrow({
        arrowSize: arrowCfg.size, arrowSide, fadeColor, backdropTone, theme,
    }) : null;
    return <ListPresentationProvider value="grouped" floating>
        <Animated.View style={insideSheet ? [{ maxHeight, flexShrink: 1, minHeight: 0 }, containerStyle, containerPaint] : [
            surfaceChrome === 'theme' ? styles.themedSurfaceShadowFrame : styles.modalShadowFrame,
            { maxHeight },
            containerStyle,
            containerPaint,
        ]}>
            {arrowNode}
            <GlassSurface themeSurface={props.themeSurface} surfaceGroup="floating" noCoat={insideSheet} finishRole={insideSheet ? null : undefined}
                floatingRole={phonePanel && !insideSheet ? 'panel' : undefined}
                style={insideSheet ? { maxHeight, flexShrink: 1, minHeight: 0 } : [
                    surfaceChrome === 'theme' ? styles.themedSurfaceClip : styles.modalClipSurface,
                    { maxHeight },
                ]}>
                <FloatingOverlaySheetContext.Provider value={false}>
                    <FloatingOverlayPhonePanelContext.Provider value={false}>{surfaceContent}</FloatingOverlayPhonePanelContext.Provider>
                </FloatingOverlaySheetContext.Provider>
                {insideSheet ? null : <SurfaceRim role="floating" radius={OVERLAY_BORDER_RADIUS} border="modal" />}
            </GlassSurface>
        </Animated.View>
    </ListPresentationProvider>;
});

function renderFloatingOverlayArrow(input: Readonly<{
    arrowSize: number;
    arrowSide: 'top' | 'bottom' | 'left' | 'right';
    fadeColor: string;
    backdropTone: ReturnType<typeof useGlassSurfaceBackdropTone>;
    theme: ReturnType<typeof useUnistyles>['theme'];
}>): React.ReactElement {
    const { arrowSize, arrowSide, fadeColor, backdropTone, theme } = input;
    const protrusion = arrowSize / 2;

    const arrowBoxStyle: ViewStyle = {
        width: arrowSize,
        height: arrowSize,
        backgroundColor: fadeColor,
        transform: [{ rotate: '45deg' as const }],
        // The arrow is part of the floating surface, so on web it frosts what lies under it like the
        // surface does (it holds no content, so its own backdrop cuts nothing off).
        ...(Platform.OS === 'web'
            ? createBackdropWebStyle({ backgroundColor: fadeColor, surfaceGroup: 'floating', backdropTone }) as unknown as ViewStyle
            : null),
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
        <View testID="floating-overlay-arrow" style={arrowWrapperStyle}>
            <View style={arrowBoxStyle} {...(Platform.OS === 'web' ? { dataSet: { happyGlassBackdrop: 'true' } } : {})} />
        </View>
    );
}
