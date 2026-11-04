import * as React from 'react';
import { Animated, Platform, ScrollView, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { ContainedPageScopeProvider } from '@/components/ui/lists/listPresentation';
import { ModalCardBody } from './ModalCardBody';
import { PopoverScrollSourceProvider, usePopoverScrollSourceRef } from '@/components/ui/popover/PopoverScrollSource';
import { ModalCardHeader } from './ModalCardHeader';
import { SheetGrabber, useSheetDismiss, useSheetDrag } from './sheetDragDismiss';
import { useModalCardDimensions, type ModalCardDimensionOptions, type ModalCardSizePreset } from './useModalCardDimensions';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';

type ModalCardFrameProps = Readonly<{
    children: React.ReactNode;
    /** Raw custom-modal bodies retain this same ancestry when they publish card chrome. */
    framed?: boolean;
    material?: 'glass' | 'solid';
    /** `none`: no title band; the content is the top of the card. The title remains the accessible name. */
    header?: 'band' | 'none';
    /** `wide`: the band's text and close stand on the content's 24 edge (a phone keeps the page gutter). */
    headerInset?: 'wide';
    leading?: React.ReactNode;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    /** `1`: the subtitle stays on one line and ends in an ellipsis. */
    subtitleLines?: 1;
    actions?: React.ReactNode;
    footer?: React.ReactNode;
    scrollHost?: 'overlay' | 'body' | 'bounded';
    bodyScroll?: 'none' | 'auto';
    onClose?: () => void;
    size?: ModalCardSizePreset;
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    bodyStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    dimensions?: ModalCardDimensionOptions;
    /** `sheet`: a phone bottom sheet — full width, top corners only, the safe area inside its body. */
    presentation?: 'card' | 'sheet' | 'fullscreen';
    /** Full-page chrome paints to the edge and keeps its controls inside the safe area. */
    safeAreaInsets?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
    /** The bottom safe area a sheet pads inside itself (its host reached the edge). */
    sheetBottomInset?: number;
}>;


const stylesheet = StyleSheet.create((theme) => ({
    shadowFrame: {
        backgroundColor: 'transparent',
        borderRadius: theme.borderRadius.modalCard,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
        alignSelf: 'center',
        minHeight: 0,
    },
    clipSurface: {
        borderRadius: theme.borderRadius.modalCard,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.modal,
            edge: resolveThemeRaisedEdge(theme, 'modal'),
            rim: surfaceUsesRim('floating', theme.dark),
        }),
        overflow: 'hidden',
        flexDirection: 'column',
        minHeight: 0,
    },
    sheetFrame: {
        alignSelf: 'stretch',
        flexShrink: 1,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    fullscreenFrame: {
        alignSelf: 'stretch',
        minHeight: 0,
    },
    fullscreenSurface: {
        overflow: 'hidden',
        flexDirection: 'column',
        minHeight: 0,
    },
    // Card chrome owns the edge inset; consumers arrange actions, not the card's padding.
    footer: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
    bodyScrollView: {
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
    bodyScrollContent: {
        flexGrow: 1,
        minHeight: 0,
    },
    bodyBounded: {
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        overflow: 'hidden',
    },
    boundedSurface: {
        // Fills a frame that kept its earlier height; sized by content otherwise.
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
    bodyUnscrolled: {
        flexGrow: 0,
        flexShrink: 0,
        overflow: 'visible',
    },
}));

export function ModalCardFrame(props: ModalCardFrameProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const framed = props.framed !== false;
    const scrollHost = framed ? props.scrollHost ?? 'overlay' : 'overlay';
    const sheet = framed && props.presentation === 'sheet';
    const fullscreen = framed && props.presentation === 'fullscreen';
    const bodyScroll = framed ? props.bodyScroll ?? 'none' : 'none';
    // `bounded` sizes to its content up to the viewport bound; `body` and fullscreen take the bound as their height.
    const bounded = framed && scrollHost === 'bounded' && !fullscreen;
    const fixedHeight = framed && (scrollHost === 'body' || fullscreen);
    const reducedMotion = useReducedMotionPreference();
    // A card that scrolls its own body is the scroll source of the lists inside it; otherwise they keep the modal's.
    const bodyScrollRef = React.useRef<ScrollView | null>(null);
    const inheritedScrollSource = usePopoverScrollSourceRef();
    const dimensions = useModalCardDimensions({
        ...props.dimensions,
        size: props.size ?? props.dimensions?.size,
        fullscreen,
    });

    // A sheet its modal can dismiss draws the grabber and follows a downward drag (lab A2p).
    const sheetDismiss = useSheetDismiss();
    const dismiss = sheet ? sheetDismiss : null;
    const drag = useSheetDrag(dismiss);
    // A bounded card keeps the tallest height it has shown while it is presented, so a pushed child (a
    // folder browser) or a narrowed list never shrinks the container under the person; it still grows.
    const [shownHeight, setShownHeight] = React.useState(0);
    const dragLayout = dismiss ? drag.onLayout : null;
    const onFrameLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        if (bounded) setShownHeight(previous => (height > previous ? height : previous));
        dragLayout?.(event);
    }, [bounded, dragLayout]);


    const hasHeader = framed && props.header !== 'none' && (props.leading != null
        || props.title != null
        || props.subtitle != null
        || props.actions != null
        || typeof props.onClose === 'function');

    return (
        <Animated.View
            testID={props.testID}
            {...(framed && Platform.OS === 'web'
                ? ({ dataSet: { happyModalCardBoundary: 'true' } } as unknown as Record<string, unknown>)
                : null)}
            {...(dismiss || bounded ? { onLayout: onFrameLayout } : {})}
            style={[
                dismiss ? { transform: [{ translateY: drag.offset }] } : null,
                framed ? (fullscreen ? styles.fullscreenFrame : styles.shadowFrame) : null,
                sheet
                    ? [styles.sheetFrame, { width: '100%', maxWidth: '100%' }]
                    : framed ? {
                        width: dimensions.width,
                        maxWidth: dimensions.width,
                        // A card whose owner changes its width (a command surface widening for a detail
                        // column) travels to the new width instead of jumping; reduced motion snaps.
                        ...(Platform.OS === 'web' ? {
                            transitionProperty: 'width, max-width',
                            transitionDuration: `${reducedMotion ? 0 : motionTokens.durationMs.base}ms`,
                            transitionTimingFunction: motionTokens.easingCss.standard,
                        } as unknown as ViewStyle : null),
                    } : null,
                fixedHeight
                    ? {
                        height: dimensions.maxHeight,
                    }
                    : bounded ? { maxHeight: dimensions.maxHeight, ...(shownHeight > 0 ? { minHeight: Math.min(shownHeight, dimensions.maxHeight) } : null) } : null,
                props.style,
            ]}
        >
            <GlassSurface surfaceGroup="floating" floatingRole="panel" enabled={framed && !fullscreen && props.material !== 'solid'}
                finishRole={framed ? undefined : null}
                solidColor={!framed ? 'transparent' : fullscreen ? theme.colors.surface.base : undefined} style={[
                framed ? (fullscreen ? styles.fullscreenSurface : styles.clipSurface) : null,
                scrollHost === 'body' || fullscreen ? { flex: 1 } : bounded ? styles.boundedSurface : null,
                fullscreen ? {
                    paddingTop: props.safeAreaInsets?.top ?? 0,
                    paddingRight: props.safeAreaInsets?.right ?? 0,
                    paddingBottom: props.safeAreaInsets?.bottom ?? 0,
                    paddingLeft: props.safeAreaInsets?.left ?? 0,
                } : null,
                sheet ? [styles.sheetFrame, { paddingBottom: props.sheetBottomInset ?? 0 }] : null,
            ]}>
                {dismiss ? <SheetGrabber onDismiss={dismiss} panHandlers={drag.panHandlers} {...(props.testID ? { testID: `${props.testID}.grabber` } : {})} /> : null}
                {hasHeader ? (
                    <ModalCardHeader
                        leading={props.leading}
                        title={props.title}
                        subtitle={props.subtitle}
                        subtitleLines={props.subtitleLines}
                        actions={props.actions}
                        onClose={props.onClose}
                        inset={props.headerInset}
                        titleTestID={props.titleTestID}
                        subtitleTestID={props.subtitleTestID}
                        closeButtonTestID={props.closeButtonTestID}
                        style={props.headerStyle}
                    />
                ) : null}

                {/* A card (not fullscreen) is a contained scope: page lists inside take its width (R-APP-7). */}
                <ContainedPageScopeProvider contained={framed && !fullscreen}>
                    {/* One body parent: chrome and scroll changes must not retire pending input custody. */}
                    <ScrollView
                        ref={bodyScrollRef}
                        testID={bodyScroll === 'auto' ? 'modal-card-body-scroll' : undefined}
                        style={bodyScroll === 'auto' ? styles.bodyScrollView
                            // A fixed-height card whose content owns its scrolling (a catalog list beside its
                            // details): the body takes the card's height and never grows past it.
                            : fixedHeight || bounded ? styles.bodyBounded : styles.bodyUnscrolled}
                        contentContainerStyle={bodyScroll === 'auto' ? styles.bodyScrollContent
                            : fixedHeight || bounded ? styles.bodyBounded : undefined}
                        scrollEnabled={bodyScroll === 'auto'}
                        keyboardShouldPersistTaps="handled"
                        nestedScrollEnabled={bodyScroll === 'auto'}
                    >
                        <PopoverScrollSourceProvider scrollSourceRef={bodyScroll === 'auto' ? bodyScrollRef : inheritedScrollSource}>
                            <ModalCardBody fill={framed && bodyScroll !== 'auto'} style={props.bodyStyle}>
                                {props.children}
                            </ModalCardBody>
                        </PopoverScrollSourceProvider>
                    </ScrollView>
                </ContainedPageScopeProvider>

                {framed && props.footer != null ? (
                    <View testID="modal-card-footer" style={[styles.footer, props.footerStyle]}>
                        {/* Dialog actions are one `normal`-tier family: primary, secondary and destructive all take
                            the same `label` words and geometry a WebAlert action uses. */}
                        <RoundButtonSizeScope size="normal" presentation="uniform">{props.footer}</RoundButtonSizeScope>
                    </View>
                ) : null}
                {framed && !fullscreen ? <SurfaceRim role="floating" radius={theme.borderRadius.modalCard} border="modal" /> : null}
            </GlassSurface>
        </Animated.View>
    );
}
