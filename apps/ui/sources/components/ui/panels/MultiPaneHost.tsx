import * as React from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ResolvedPaneLayout } from './paneBreakpoints';
import { ResizableDockedPane } from './ResizableDockedPane';
import { PaneAnimatedScrimPressable } from './motion/PaneAnimatedScrimPressable';
import {
    ModalPaneBoundaryView,
    useModalPaneBoundary,
    useModalPanePresentation,
} from './ModalPaneBoundary';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';
import { ESCAPE_LAYER_PRIORITIES } from '@/keyboard/escape';
import { t } from '@/text';
import { shadowLevelStyle } from '@/shadowElevation';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { SurfaceRim } from '@/components/ui/surfaces/SurfaceRim';
import { RetainedPanelSurface } from './RetainedPanelSurface';
import { DEFAULT_DETAILS_MIN_PX, DEFAULT_RIGHT_MIN_PX, DEFAULT_SESSION_MIN_PX, DEFAULT_SESSION_WIDTH_PX } from './paneBreakpoints';
import { usePaneRegionFocusBoundary } from '@/components/appShell/panes/paneRegion';
import { PaneMainBodyPresentationContext, PaneMainComposerReporterContext } from './paneMainComposerAnchor';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { AppShellTailSlot } from '@/components/navigation/shell/appShellTail';
import { PaneHeaderScrollIsolation } from '@/components/appShell/panes/paneHeaderScroll';
import { appShellColumnPlaneColor } from '@/components/navigation/shell/appRail/appShellColumnSurface';

// A pane floating over the main content (overlay presentation) rounds the one edge that shows.
const PANE_OVERLAY_CORNER_RADIUS_PX = 16;
// The soft scrim (Details over the transcript while the side column stays, lab FB1) is the theme's soft
// scrim at a share of its strength: the page reads as behind, not shut.
const SOFT_SCRIM_SHARE = 0.6;
// The pre-boundary Escape owner closes Details before Right when both docked
// columns are present. Keep that user-visible precedence inside the one pane
// layer rather than relying on hook registration order.
const DOCKED_DETAILS_ESCAPE_PRIORITY = ESCAPE_LAYER_PRIORITIES.pane + 1;
const NOOP = () => {};

export type MultiPaneHostProps = Readonly<{
    main: React.ReactNode;
    hideMain?: boolean;
    mirrored?: boolean;
    detailsClosable?: boolean;
    mainDrawerOpen?: boolean;
    mainAccessibilityLabel?: string;
    mainOverlayFocusReturnRef?: FocusReturnMutableRef;
    mainDockWidthPx?: number;
    mainDockMaxWidthPx?: number;
    onCloseMain?: () => void;
    onCommitMainDockWidthPx?: (widthPx: number) => void;
    onDragMainDockWidthPx?: React.ComponentProps<typeof ResizableDockedPane>['onDragWidthPx'];
    onResetMainDockWidthPx?: () => void;
    onResetRightDockWidthPx?: () => void;
    onResetDetailsDockWidthPx?: () => void;
    rightPane: React.ReactNode | null;
    /** The right pane presents inside the main column, above its composer (lab AR1 EFv). */
    rightInMain?: boolean;
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
    onDragRightDockWidthPx?: React.ComponentProps<typeof ResizableDockedPane>['onDragWidthPx'];
    onDragDetailsDockWidthPx?: React.ComponentProps<typeof ResizableDockedPane>['onDragWidthPx'];
    rightOverlayFocusReturnRef?: FocusReturnMutableRef;
    detailsOverlayFocusReturnRef?: FocusReturnMutableRef;
    /**
     * `soft` when Details is a drawer opened from the side column's list: the list beside it stays
     * the context, so main is only quieted, not shaded (details lab 2, Q1).
     */
    detailsScrim?: 'standard' | 'soft';
    /**
     * Set when the shell stands this page's right panel on the canvas (calm-shell R4-2): while docked
     * the right column renders in `host`, beside the page sheet, and `hidden` while this page is not on
     * screen. The column keeps one mounted instance whichever place it stands in.
     */
    rightTail?: Readonly<{ host: HTMLElement | null; hidden: boolean }>;
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
    const overlayZIndexBase = 50;
    const mirrored = props.mirrored === true;
    const mainModalActive = layout.main === 'overlay' && props.mainDrawerOpen === true && hideMain !== true;
    const mainLabel = props.mainAccessibilityLabel ?? t('ui.modalPane.right');
    const mainPresence = useModalPanePresentation({ targetOpen: mainModalActive, node: main, overlay: true,
        onClose: props.onCloseMain ?? NOOP });
    const mainModalBoundary = useModalPaneBoundary({ active: mainModalActive, label: mainLabel,
        focusReturnRef: props.mainOverlayFocusReturnRef,
        discardPendingFocusReturn: hideMain !== true && layout.main !== 'overlay',
        onRequestClose: mainPresence.requestClose, escapeEnabled: mainModalActive,
        escapePriority: ESCAPE_LAYER_PRIORITIES.overlay + 1, allowEditableEscape: mainModalActive });

    // Pane *presence* is the logical open signal. Layout controls whether it's docked/overlay/hidden.
    // This lets us keep a pane mounted (state preserved) even when the layout temporarily hides it
    // (e.g. overlayStack where details overlays and right is hidden).
    const detailsPresence = useModalPanePresentation({
        targetOpen: Boolean(detailsPane),
        node: detailsPane,
        overlay: layout.details === 'overlay',
        onClose: onCloseDetails,
    });
    const rightPresence = useModalPanePresentation({
        targetOpen: Boolean(rightPane),
        node: rightPane,
        overlay: layout.right === 'overlay',
        onClose: onCloseRight,
    });
    const rightInMain = props.rightInMain === true;
    const rightModalActive = !rightInMain && layout.right === 'overlay' && rightPresence.present && !mainModalActive;
    const detailsModalActive = layout.details === 'overlay' && detailsPresence.present && !rightModalActive && !mainModalActive;
    const rightModalLabel = t('ui.modalPane.right');
    const detailsModalLabel = t('ui.modalPane.details');
    const detailsModalBoundary = useModalPaneBoundary({
        active: detailsModalActive,
        label: detailsModalLabel,
        onRequestClose: detailsPresence.requestClose,
        focusReturnRef: props.detailsOverlayFocusReturnRef,
        discardPendingFocusReturn: Boolean(detailsPane) && layout.details !== 'overlay',
        escapeEnabled: props.detailsClosable !== false && (detailsModalActive || (layout.details === 'docked' && detailsPresence.present)),
        escapePriority: detailsModalActive
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : DOCKED_DETAILS_ESCAPE_PRIORITY,
        allowEditableEscape: detailsModalActive,
    });
    const rightModalBoundary = useModalPaneBoundary({
        active: rightModalActive,
        label: rightModalLabel,
        onRequestClose: rightPresence.requestClose,
        focusReturnRef: props.rightOverlayFocusReturnRef,
        discardPendingFocusReturn: Boolean(rightPane) && (rightInMain || layout.right !== 'overlay'),
        // Escape leaves a pane presented in the session column for the transcript, as Back does.
        escapeEnabled: rightModalActive || ((rightInMain || layout.right === 'docked') && rightPresence.present),
        escapePriority: rightModalActive
            ? ESCAPE_LAYER_PRIORITIES.overlay
            : ESCAPE_LAYER_PRIORITIES.pane,
        allowEditableEscape: rightModalActive,
    });
    const {
        nativeAccessibilityFocusAnchor: detailsNativeAccessibilityFocusAnchor,
        nativeBackLayer: detailsNativeBackLayer,
        ...detailsModalOverlayProps
    } = detailsModalBoundary.overlayProps;
    const {
        nativeAccessibilityFocusAnchor: rightNativeAccessibilityFocusAnchor,
        nativeBackLayer: rightNativeBackLayer,
        ...rightModalOverlayProps
    } = rightModalBoundary.overlayProps;
    const activeMainBoundary = rightModalActive
        ? rightModalBoundary
        : detailsModalActive
            ? detailsModalBoundary
            : null;
    const setMainUnderlayFocusRef = React.useCallback<React.RefCallback<HTMLElement>>((node) => {
        detailsModalBoundary.setUnderlayFocusRef(node);
        rightModalBoundary.setUnderlayFocusRef(node);
    }, [detailsModalBoundary, rightModalBoundary]);
    // The pane host already owns these visible/covered facts. Feed them into
    // the private focus boundary instead of asking plugin surfaces to infer
    // their own presentation state.
    const mainFocusEligible = activeMainBoundary === null;
    // Presented is not focusable: a docked column under another pane's overlay is still on screen.
    const mainPresented = hideMain !== true && (layout.main !== 'overlay' || mainModalActive);
    const mainRegionVisible = mainFocusEligible && mainPresented;
    const mainRegionFocus = usePaneRegionFocusBoundary('main', mainRegionVisible);
    const detailsOverlayFocusEligible = detailsModalActive && !detailsPresence.closing;
    const rightOverlayFocusEligible = rightModalActive && !rightPresence.closing;

    const detailsDocked = layout.details === 'docked' && detailsPresence.present;
    const rightDocked = layout.right === 'docked' && rightPresence.present;
    // The details drawer is inset by a docked side column's width, so it covers the main column only:
    // the column beside it stays live (T-INTEL H-T1). Only what an overlay actually covers is its underlay.
    const rightBesideDetailsOverlay = rightDocked && !rightInMain;
    // Docked with the canvas placement, the right column stands outside the page sheet.
    const rightOnCanvas = props.rightTail !== undefined && rightDocked && !rightInMain && !mirrored;
    const rightUnderDetailsOverlay = detailsModalActive && !rightBesideDetailsOverlay;
    const shouldHideDockedMainRegion = hideMain === true;
    const mainWidthPx = props.mainDockWidthPx ?? DEFAULT_SESSION_WIDTH_PX;
    // Hide/show (lab H1): the column slides toward its own edge and back (`overlay.panel`, a fade alone
    // under reduced motion) while its neighbours take or give back its width on the same frame. It
    // stays rendered, out of flow and inert, until the slide has left; a second press retargets.
    const reducedMotion = useReducedMotionPreference();
    // Web runs the slide on the compositor (transform and opacity), so the neighbours' relayout on the
    // same frame cannot eat it; native drives the same values through Animated.
    // A hidden column is given no width; it leaves at the width it had.
    const shownMainWidthRef = React.useRef(mainWidthPx);
    if (!shouldHideDockedMainRegion && mainWidthPx > 0) shownMainWidthRef.current = mainWidthPx;
    const slideWidthPx = shownMainWidthRef.current;
    const mainSlide = React.useRef(new Animated.Value(shouldHideDockedMainRegion ? 0 : 1)).current;
    const mainSlideNodeRef = React.useRef<View | null>(null);
    const mainSlideHiddenRef = React.useRef(shouldHideDockedMainRegion);
    const [mainParked, setMainParked] = React.useState(shouldHideDockedMainRegion);
    React.useLayoutEffect(() => {
        const hidden = shouldHideDockedMainRegion;
        if (mainSlideHiddenRef.current === hidden) return;
        mainSlideHiddenRef.current = hidden;
        if (!hidden) setMainParked(false);
        const panel = motionTokens.overlay.panel;
        const duration = reducedMotion ? panel.reducedMotionFadeMs : hidden ? panel.exitMs : panel.enterMs;
        const park = () => { if (hidden) setMainParked(true); };
        if (Platform.OS === 'web') {
            const element = mainSlideNodeRef.current as unknown as HTMLElement | null;
            if (!element || typeof element.animate !== 'function') { park(); return; }
            // A second press retargets from where the column is now.
            const current = getComputedStyle(element);
            const away = { transform: reducedMotion ? 'none' : `translateX(${mirrored ? slideWidthPx : -slideWidthPx}px)`, opacity: 0 };
            const settled = { transform: 'none', opacity: 1 };
            const from = { transform: current.transform === 'none' ? 'none' : current.transform, opacity: Number(current.opacity) };
            for (const running of element.getAnimations()) running.cancel();
            const animation = element.animate([hidden ? from : (from.opacity < 1 ? from : away), hidden ? away : settled],
                { duration, easing: motionTokens.easingCss.standard, fill: 'forwards' });
            animation.onfinish = () => { park(); if (!hidden) animation.cancel(); };
            return;
        }
        const animation = Animated.timing(mainSlide, { toValue: hidden ? 0 : 1, duration, easing: motionTokens.easing.standard, useNativeDriver: false });
        animation.start(({ finished }) => { if (finished) park(); });
        return () => animation.stop();
    }, [mainSlide, mirrored, reducedMotion, shouldHideDockedMainRegion, slideWidthPx]);
    const mainLeaving = shouldHideDockedMainRegion && !mainParked;
    const mainSlideStyle = Platform.OS === 'web' ? { flex: 1, minWidth: 0, minHeight: 0 } : {
        flex: 1, minWidth: 0, minHeight: 0,
        opacity: mainSlide,
        transform: [{ translateX: reducedMotion ? 0 : mainSlide.interpolate({ inputRange: [0, 1], outputRange: [mirrored ? slideWidthPx : -slideWidthPx, 0] }) }],
    };
    // A pane presented in the main column covers it down to the composer's top edge. The composer
    // reports itself (`PaneMainComposerAnchor`); the inset is measured against this column.
    const mainColumnNodeRef = React.useRef<View | null>(null);
    const mainComposerNodeRef = React.useRef<View | null>(null);
    const [mainComposerInsetPx, setMainComposerInsetPx] = React.useState(0);
    const measureMainComposerInset = React.useCallback(() => {
        const column = mainColumnNodeRef.current;
        const composer = mainComposerNodeRef.current;
        if (!column || !composer || typeof column.measureInWindow !== 'function' || typeof composer.measureInWindow !== 'function') {
            setMainComposerInsetPx(0);
            return;
        }
        column.measureInWindow((_x, columnY, _width, columnHeight) => {
            composer.measureInWindow((_cx, composerY, _cw, composerHeight) => {
                // A column that is not on screen (a hidden workspace screen) measures 0×0: keep the last inset.
                if (!(columnHeight > 0)) return;
                const next = composerHeight > 0 ? Math.max(0, Math.round(columnY + columnHeight - composerY)) : 0;
                setMainComposerInsetPx((current) => (Math.abs(current - next) > 1 ? next : current));
            });
        });
    }, []);
    const reportMainComposer = React.useCallback((node: View | null) => {
        mainComposerNodeRef.current = node;
        measureMainComposerInset();
    }, [measureMainComposerInset]);
    const rightInMainVisible = rightInMain && !shouldHideDockedMainRegion && (layout.main !== 'overlay' || mainModalActive);
    const mainFocusRef = React.useCallback((node: unknown) => {
        mainColumnNodeRef.current = node as View | null;
        mainRegionFocus.ref(node);
        if (mainModalActive) mainModalBoundary.setOverlayFocusRef(node as HTMLElement | null);
    }, [mainModalActive, mainModalBoundary.setOverlayFocusRef, mainRegionFocus.ref]);

    return (
        <View style={{ flex: 1, flexDirection: mirrored ? 'row-reverse' : 'row', position: 'relative' }}>
                <View key="main" ref={mainFocusRef} testID="multi-pane-main-column"
                    onFocus={mainRegionFocus.onFocus} onLayout={measureMainComposerInset} role={Platform.OS === 'web' ? 'region' : undefined}
                    tabIndex={Platform.OS === 'web' && mainRegionVisible ? -1 : undefined}
                    focusable={mainRegionVisible}
                    accessibilityLabel={mainLabel}
                    pointerEvents={shouldHideDockedMainRegion ? 'none' : undefined}
                    {...(Platform.OS === 'web' && shouldHideDockedMainRegion ? { inert: true, 'aria-hidden': true } : {})}
                    style={mainLeaving ? { position: 'absolute', top: 0, bottom: 0, ...(mirrored ? { right: 0 } : { left: 0 }), width: slideWidthPx, overflow: 'hidden', zIndex: 1, backgroundColor: theme.colors.surface.base }
                        : shouldHideDockedMainRegion ? { position: 'absolute', width: 0, height: '100%', overflow: 'hidden', opacity: 0, zIndex: -1 }
                        // The main column as a drawer is a layer like the other pane overlays: its leading corners
                        // round and it carries their elevation, so it reads as lifted over the editor (lab F10).
                        : layout.main === 'overlay' ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: mainWidthPx, zIndex: overlayZIndexBase + 5, backgroundColor: theme.colors.surface.base,
                            borderTopLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX, borderBottomLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX,
                            overflow: 'hidden', ...shadowLevelStyle(theme.colors.shadowLevels[6]) }
                            : { flex: mirrored ? undefined : 1, width: mirrored ? mainWidthPx : undefined, minWidth: 0, minHeight: 0, position: 'relative' }}>
                    <Animated.View ref={mainSlideNodeRef} style={mainSlideStyle}>
                    <RetainedPanelSurface isActive={!shouldHideDockedMainRegion || mainLeaving} mode="flow" testID="multi-pane-main-retained">
                    <ResizableDockedPane widthPx={mainLeaving ? slideWidthPx : mainWidthPx}
                        // Beside the side panes the Session column takes the room they leave (flex), so it
                        // follows its host on the frame a window resizes; only a mirrored, overlaid or
                        // leaving column has a width of its own.
                        fill={!mirrored && !mainLeaving && layout.main !== 'overlay'}
                        minWidthPx={mainLeaving ? slideWidthPx : mirrored && layout.main !== 'overlay' ? DEFAULT_SESSION_MIN_PX : mainWidthPx}
                        maxWidthPx={mainLeaving ? slideWidthPx : mirrored && layout.main !== 'overlay' ? props.mainDockMaxWidthPx ?? mainWidthPx : mainWidthPx}
                        resizeEdge="left" onCommitWidthPx={props.onCommitMainDockWidthPx ?? NOOP}
                        onDragWidthPx={props.onDragMainDockWidthPx} onResetRequest={props.onResetMainDockWidthPx}>
                    <ModalPaneBoundaryView
                        ref={setMainUnderlayFocusRef}
                        testID="multi-pane-main-underlay"
                        style={{ flex: 1, minWidth: 0, minHeight: 0 }}
                        {...(mainModalActive ? mainModalBoundary.overlayProps : activeMainBoundary?.underlayProps ?? {})}
                    >
                        <PluginSurfaceFocusEligibilityProvider active={mainFocusEligible} presentationActive={mainPresented}>
                            <PaneMainComposerReporterContext.Provider value={reportMainComposer}>
                                <PaneMainBodyPresentationContext.Provider value={mainPresented && !(rightInMain && rightPresence.present)}>
                                {main}
                                </PaneMainBodyPresentationContext.Provider>
                            </PaneMainComposerReporterContext.Provider>
                        </PluginSurfaceFocusEligibilityProvider>
                    </ModalPaneBoundaryView>
                    {!mirrored && detailsModalActive ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-details-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: detailsModalLabel })}
                            onPress={detailsPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
                                zIndex: overlayZIndexBase,
                                backgroundColor: theme.colors.overlay.scrimSoft,
                                opacity: detailsPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, props.detailsScrim === 'soft' ? SOFT_SCRIM_SHARE : 1] }),
                            }}
                        />
                    ) : null}
                    {!mirrored && rightModalActive ? (
                        <PaneAnimatedScrimPressable
                            testID="multi-pane-right-scrim"
                            accessibilityRole="button"
                            accessibilityLabel={t('ui.modalPane.dismiss', { pane: rightModalLabel })}
                            onPress={rightPresence.requestClose}
                            animatedStyle={{
                                position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
                                zIndex: overlayZIndexBase + 2,
                                backgroundColor: theme.colors.overlay.scrimSoft,
                                opacity: rightPresence.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                            }}
                        />
                    ) : null}
                    </ResizableDockedPane>
                    </RetainedPanelSurface>
                    </Animated.View>
                </View>
            {detailsPresence.present ? (
                <PaneColumn
                    key="details"
                    name="details"
                    mirrored={mirrored}
                    flexible={mirrored}
                    presentation={layout.details}
                    modalActive={detailsModalActive}
                    progress={detailsPresence.progress}
                    widthPx={detailsDockWidthPx}
                    minWidthPx={props.detailsDockMinWidthPx ?? DEFAULT_DETAILS_MIN_PX}
                    maxWidthPx={props.detailsDockMaxWidthPx ?? Number.POSITIVE_INFINITY}
                    onCommitWidthPx={props.onCommitDetailsDockWidthPx}
                    onDragWidthPx={props.onDragDetailsDockWidthPx}
                    onResetWidthPx={props.onResetDetailsDockWidthPx}
                    overlayRightInsetPx={rightDocked && !rightOnCanvas ? rightDockWidthPx : 0}
                    overlayZIndex={overlayZIndexBase + 1}
                    overlayFocusRef={detailsModalBoundary.setOverlayFocusRef}
                    overlayProps={detailsModalOverlayProps}
                    underlayProps={mainModalActive ? mainModalBoundary.underlayProps : rightModalActive ? rightModalBoundary.underlayProps : undefined}
                    underlayFocusRef={mirrored ? mainModalBoundary.setUnderlayFocusRef : undefined}
                    nativeAccessibilityFocusAnchor={detailsNativeAccessibilityFocusAnchor}
                    nativeBackLayer={detailsNativeBackLayer}
                    focusEligible={layout.details === 'docked' ? !rightModalActive && !mainModalActive : detailsOverlayFocusEligible}
                >
                    {detailsPresence.node}
                    {mirrored && (mainModalActive || rightModalActive) ? <PaneAnimatedScrimPressable
                        testID={mainModalActive ? 'multi-pane-main-scrim' : 'multi-pane-right-scrim'}
                        accessibilityRole="button" accessibilityLabel={t('ui.modalPane.dismiss', { pane: mainModalActive ? mainLabel : rightModalLabel })}
                        onPress={mainModalActive ? mainPresence.requestClose : rightPresence.requestClose}
                        // The session drawer dims the editor (lab F10); Files over the editor is a light,
                        // non-blocking overlay (lab F12): a press outside still closes it, nothing dims.
                        animatedStyle={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: overlayZIndexBase + 4,
                            backgroundColor: mainModalActive ? theme.colors.overlay.scrimSoft : 'transparent' }} /> : null}
                </PaneColumn>
            ) : null}
            {rightPresence.present ? (
                <MaybeTailSlot key="right" tail={props.rightTail} host={rightOnCanvas ? props.rightTail?.host ?? null : null}>
                <PaneColumn
                    name="right"
                    mirrored={mirrored}
                    onCanvas={rightOnCanvas}
                    presentation={rightInMain ? (rightInMainVisible ? 'main' : 'hidden') : layout.right}
                    modalActive={rightModalActive}
                    progress={rightPresence.progress}
                    // Over the session column the pane takes the column's width, and its edge resizes the column.
                    {...(rightInMain ? {
                        widthPx: mainWidthPx,
                        minWidthPx: mirrored && layout.main !== 'overlay' ? DEFAULT_SESSION_MIN_PX : mainWidthPx,
                        maxWidthPx: mirrored && layout.main !== 'overlay' ? props.mainDockMaxWidthPx ?? mainWidthPx : mainWidthPx,
                        onCommitWidthPx: props.onCommitMainDockWidthPx ?? NOOP,
                        onDragWidthPx: props.onDragMainDockWidthPx,
                        onResetWidthPx: props.onResetMainDockWidthPx,
                        mainBottomInsetPx: mainComposerInsetPx,
                        mainZIndex: overlayZIndexBase + 6,
                    } : {
                        widthPx: rightDockWidthPx,
                        minWidthPx: props.rightDockMinWidthPx ?? DEFAULT_RIGHT_MIN_PX,
                        maxWidthPx: props.rightDockMaxWidthPx ?? Number.POSITIVE_INFINITY,
                        onCommitWidthPx: props.onCommitRightDockWidthPx,
                        onDragWidthPx: props.onDragRightDockWidthPx,
                        onResetWidthPx: props.onResetRightDockWidthPx,
                    })}
                    overlayRightInsetPx={!mirrored && detailsDocked ? detailsDockWidthPx : 0}
                    overlayZIndex={overlayZIndexBase + 3}
                    overlayFocusRef={rightModalBoundary.setOverlayFocusRef}
                    overlayProps={rightModalOverlayProps}
                    underlayProps={mainModalActive ? mainModalBoundary.underlayProps : rightUnderDetailsOverlay ? detailsModalBoundary.underlayProps : undefined}
                    nativeAccessibilityFocusAnchor={rightNativeAccessibilityFocusAnchor}
                    nativeBackLayer={rightNativeBackLayer}
                    focusEligible={rightInMain ? rightInMainVisible && mainFocusEligible
                        : layout.right === 'docked' ? !rightUnderDetailsOverlay && !mainModalActive : rightOverlayFocusEligible}
                >
                    {rightPresence.node}
                </PaneColumn>
                </MaybeTailSlot>
            ) : null}
        </View>
    );
});

/**
 * One mounted column per pane. Docking, overlaying and parking change its layout and modal
 * attributes, never its parents: a pane's editor draft, focus and scroll belong to this instance.
 */
function MaybeTailSlot(props: Readonly<{
    tail: MultiPaneHostProps['rightTail'];
    host: HTMLElement | null;
    children: React.ReactElement;
}>): React.ReactNode {
    if (!props.tail) return props.children;
    return <AppShellTailSlot host={props.host} hidden={props.tail.hidden}>{props.children}</AppShellTailSlot>;
}

function PaneColumn(props: Readonly<{
    name: 'right' | 'details';
    mirrored?: boolean;
    /** Docked on the shell's canvas beside the page: the navigation plane's paint, no edge of its own. */
    onCanvas?: boolean;
    flexible?: boolean;
    /** `main`: laid over the main column down to its composer (lab AR1 EFv). */
    presentation: ResolvedPaneLayout['details'] | 'main';
    mainBottomInsetPx?: number;
    mainZIndex?: number;
    modalActive: boolean;
    progress: Animated.Value;
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number) => void;
    onDragWidthPx?: (widthPx: number | null) => void;
    onResetWidthPx?: () => void;
    overlayRightInsetPx: number;
    overlayZIndex: number;
    overlayFocusRef: ReturnType<typeof useModalPaneBoundary>['setOverlayFocusRef'];
    overlayProps: Omit<ReturnType<typeof useModalPaneBoundary>['overlayProps'], 'nativeAccessibilityFocusAnchor' | 'nativeBackLayer'>;
    underlayProps?: Readonly<Record<string, unknown>>;
    underlayFocusRef?: ReturnType<typeof useModalPaneBoundary>['setUnderlayFocusRef'];
    nativeAccessibilityFocusAnchor: ReturnType<typeof useModalPaneBoundary>['overlayProps']['nativeAccessibilityFocusAnchor'];
    nativeBackLayer: ReturnType<typeof useModalPaneBoundary>['overlayProps']['nativeBackLayer'];
    focusEligible: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const docked = props.presentation === 'docked';
    const overlay = props.presentation === 'overlay';
    const hidden = props.presentation === 'hidden';
    const inMain = props.presentation === 'main';
    const regionFocus = usePaneRegionFocusBoundary(props.name, !hidden && props.focusEligible);
    const setFocusRef = React.useCallback((node: unknown) => {
        regionFocus.ref(node);
        props.underlayFocusRef?.(node as HTMLElement | null);
        if (props.modalActive) props.overlayFocusRef(node as HTMLElement | null);
    }, [props.modalActive, props.overlayFocusRef, props.underlayFocusRef, regionFocus.ref]);
    const boundaryProps = props.modalActive ? props.overlayProps : (props.underlayProps ?? {});
    return (
        <Animated.View
            role={Platform.OS === 'web' ? 'region' : undefined}
            accessibilityLabel={props.name === 'right' ? t('ui.modalPane.right') : t('ui.modalPane.details')}
            aria-hidden={Platform.OS === 'web' && hidden ? true : undefined}
            accessibilityElementsHidden={hidden}
            importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
            style={inMain ? {
                // The session column's own sub-page: its place and width, above the composer, no edge of its own.
                position: 'absolute',
                top: 0,
                ...(props.mirrored ? { right: 0 } : { left: 0 }),
                bottom: props.mainBottomInsetPx ?? 0,
                width: props.widthPx,
                zIndex: props.mainZIndex,
                overflow: 'hidden',
                opacity: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                transform: [{ translateX: props.progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
            } : docked ? {
                position: 'relative',
                // Longhands only: the flexible column (Editor first) grows from a zero basis, others keep
                // their width; mixing `flex` with `flexShrink` warns when the arrangement swaps.
                flexGrow: props.flexible ? 1 : 0,
                flexBasis: props.flexible ? 0 : 'auto',
                minWidth: 0,
                width: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, props.widthPx] }),
                overflow: 'hidden',
                flexShrink: 0,
                alignSelf: 'stretch',
                height: '100%',
                opacity: props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
                transform: [{ translateX: props.progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
            } : {
                position: 'absolute',
                top: 0,
                ...(props.mirrored ? { left: props.overlayRightInsetPx } : { right: props.overlayRightInsetPx }),
                bottom: 0,
                zIndex: overlay ? props.overlayZIndex : -1,
                backgroundColor: 'transparent',
                opacity: overlay ? props.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) : 0,
                ...(overlay ? {
                    ...(props.mirrored ? { borderTopRightRadius: PANE_OVERLAY_CORNER_RADIUS_PX, borderBottomRightRadius: PANE_OVERLAY_CORNER_RADIUS_PX }
                        : { borderTopLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX, borderBottomLeftRadius: PANE_OVERLAY_CORNER_RADIUS_PX }),
                    overflow: 'hidden',
                    ...shadowLevelStyle(theme.colors.shadowLevels[6]),
                } : {}),
                transform: [{ translateX: overlay
                    ? props.progress.interpolate({ inputRange: [0, 1], outputRange: [props.mirrored ? -props.widthPx : props.widthPx, 0] })
                    : props.mirrored ? -props.widthPx : props.widthPx }],
            }}
        >
            <ModalPaneBoundaryView
                ref={setFocusRef}
                onFocus={regionFocus.onFocus}
                tabIndex={Platform.OS === 'web' && !hidden && props.focusEligible ? -1 : undefined}
                focusable={!hidden && props.focusEligible}
                testID={hidden ? `multi-pane-${props.name}-parked`
                    : props.modalActive ? `multi-pane-${props.name}-modal` : undefined}
                {...boundaryProps}
                suppressDescendantPaneBoundaries={hidden || (!props.modalActive && props.underlayProps?.suppressDescendantPaneBoundaries === true)}
                {...(hidden ? {
                    pointerEvents: 'none' as const,
                    ...(Platform.OS === 'web'
                        ? { inert: true, 'aria-hidden': true as const }
                        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }),
                } : {})}
                style={{ flex: 1, minHeight: 0, minWidth: 0, zIndex: overlay ? props.overlayZIndex : undefined }}
            >
                <ResizableDockedPane
                    testID={`multi-pane-${props.name}-${inMain ? 'main' : docked ? 'docked' : 'overlay'}`}
                    widthPx={props.widthPx}
                    minWidthPx={props.minWidthPx}
                    maxWidthPx={props.maxWidthPx}
                    onCommitWidthPx={props.onCommitWidthPx}
                    onDragWidthPx={props.onDragWidthPx}
                    onResetRequest={props.onResetWidthPx}
                    // Over the session column the edge it resizes is the column's own (toward the editor).
                    resizeEdge={inMain ? (props.mirrored ? 'left' : 'right') : props.mirrored ? 'right' : 'left'}
                >
                    <ModalPaneBoundaryView
                        nativeAccessibilityFocusAnchor={props.nativeAccessibilityFocusAnchor}
                        nativeBackLayer={props.nativeBackLayer}
                        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
                    >
                        {/* Docked and in the column the pane is page; over the page it is a sheet that floats (DESIGN.md →
                            "Flat edge in flow; the rim only for what floats"): the floating paint, finish and rim. It keeps the
                            content material, so a transcript read in it stays as legible as in the column (lab FB1). */}
                        <GlassSurface surfaceGroup={props.onCanvas ? 'sidebar' : 'content'}
                            solidColor={overlay ? theme.colors.edge.floatingFill : props.onCanvas ? appShellColumnPlaneColor(theme.colors) : theme.colors.surface.base}
                            finishRole={overlay ? 'floating' : null} nested={docked || inMain} style={{
                            flex: 1, minHeight: 0, minWidth: 0,
                            borderLeftWidth: docked && !props.mirrored && !props.onCanvas ? StyleSheet.hairlineWidth : 0,
                            borderRightWidth: docked && props.mirrored ? StyleSheet.hairlineWidth : 0,
                            borderLeftColor: theme.colors.border.subtle, borderRightColor: theme.colors.border.subtle,
                            overflow: 'hidden',
                        }}>
                            <PluginSurfaceFocusEligibilityProvider active={props.focusEligible} presentationActive={!hidden}>
                                {/* A side pane's scrollers never drive the main column's header shade. */}
                                <PaneHeaderScrollIsolation>{props.children}</PaneHeaderScrollIsolation>
                            </PluginSurfaceFocusEligibilityProvider>
                            {overlay ? (
                                // The rim runs past the anchored edge, so only the edge that shows (and its corners) is drawn.
                                <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0,
                                    ...(props.mirrored ? { right: 0, left: -2 * PANE_OVERLAY_CORNER_RADIUS_PX } : { left: 0, right: -2 * PANE_OVERLAY_CORNER_RADIUS_PX }) }}>
                                    <SurfaceRim role="floating" radius={PANE_OVERLAY_CORNER_RADIUS_PX} border="modal" />
                                </View>
                            ) : null}
                        </GlassSurface>
                    </ModalPaneBoundaryView>
                </ResizableDockedPane>
            </ModalPaneBoundaryView>
        </Animated.View>
    );
}
