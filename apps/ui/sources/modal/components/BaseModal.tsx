import React, { useEffect, useLayoutEffect } from 'react';
import { View, TouchableWithoutFeedback, Animated, BackHandler, Platform, ScrollView, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { KeyboardAwareModalFrame } from '@/components/ui/keyboardAvoidance';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';
import { PopoverScrollSourceProvider } from '@/components/ui/popover/PopoverScrollSource';
import { requireRadixDismissableLayer, requireRadixFocusScope } from '@/utils/web/radixCjs';
import { requireReactDOM } from '@/utils/web/reactDomCjs';
import { ModalPortalTargetProvider, useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { t } from '@/text';
import { createFloatingScrimWebStyle, FloatingScrim, useFloatingScrimFrost } from '@/components/ui/overlays/FloatingScrim';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import {
    OverlayMotionFrame,
    resolveOverlayMotionPreset,
    useOverlayMotionAnimation,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useWebOverlayFocusContainment } from '@/keyboard/webOverlayFocusContainment';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from '@/keyboard/escape';
import { type FocusReturnRef, useRestoreFocusToTrigger } from '@/keyboard/focusReturn';
import { visuallyHiddenDomStyle } from '@/components/ui/accessibility/visuallyHiddenStyle';
import { SheetDismissProvider } from './card/sheetDragDismiss';
import { MODAL_Z_INDEX, resolveModalWebPortalTarget } from '@/components/ui/overlays/overlayLayers';

const BASE_MODAL_FOCUS_RETURN = { kind: 'activation-time' } as const;

const isWeb = String(Platform.OS) === 'web';
// React Native exports this static context at runtime; its TypeScript declarations omit it and RNW has none.
const NativeScrollContext = (ScrollView as typeof ScrollView & {
    Context?: React.Context<Readonly<{ horizontal: boolean }> | null>;
}).Context;
const WEB_MODAL_CARD_BOUNDARY_SELECTOR = '[data-happy-modal-card-boundary]';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
/** How far down the window a top-placed command surface starts (lab `.am-card.pal`: about an eighth). */
const COMMAND_SURFACE_TOP_SHARE_VH = 12;
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = isWeb
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

type ClosestCapableEventTarget = EventTarget & {
    closest: (selector: string) => Element | null;
};

function isClosestCapableEventTarget(target: EventTarget | null): target is ClosestCapableEventTarget {
    return typeof target === 'object'
        && target !== null
        && 'closest' in target
        && typeof (target as { closest?: unknown }).closest === 'function';
}

function isInsideWebModalCardBoundary(target: EventTarget | null): boolean {
    if (target == null) return false;

    if (isClosestCapableEventTarget(target)) {
        return target.closest(WEB_MODAL_CARD_BOUNDARY_SELECTOR) != null;
    }

    if (typeof Node !== 'undefined' && target instanceof Node) {
        return target.parentElement?.closest(WEB_MODAL_CARD_BOUNDARY_SELECTOR) != null;
    }

    return false;
}

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    /**
     * Escape and the hardware back step back instead of closing: a sheet that pushed a view inside itself
     * returns to the view under it. The scrim and the sheet's drag still close it (`onClose`).
     */
    onBack?: () => void;
    children: React.ReactNode;
    accessibilityLabel?: string;
    testID?: string;
    closeOnBackdrop?: boolean;
    showBackdrop?: boolean;
    zIndexBase?: number;
    webPlacement?: 'auto' | 'top';
    /** `bottom` anchors the content to the bottom edge (a phone sheet) on every platform. */
    placement?: 'center' | 'bottom' | 'fullscreen';
    /** A stage supplies its own entrance and exit while the modal keeps input custody. */
    motion?: 'none';
    /** The overlay scrolls by default; bounded modal bodies may own their one scroll region. */
    scrollHost?: 'overlay' | 'body';
    webPortalTarget?: ModalPortalTarget;
    focusReturnRef?: FocusReturnRef;
    /** On web, retain the opening control when the provided geometry anchor cannot receive focus. */
    focusReturnFallback?: 'activation-time';
}

function ModalContentFrame({ motion, ...props }: React.ComponentProps<typeof OverlayMotionFrame> & Readonly<{ motion?: 'none' }>) {
    if (motion === 'none') return <View pointerEvents={props.pointerEvents} style={props.style}>{props.children}</View>;
    return <OverlayMotionFrame {...props} />;
}

export function BaseModal({
    visible,
    onClose,
    onBack,
    children,
    accessibilityLabel,
    testID,
    closeOnBackdrop = true,
    showBackdrop = true,
    zIndexBase,
    webPlacement = 'auto',
    placement = 'center',
    motion,
    scrollHost = 'overlay',
    webPortalTarget = null,
    focusReturnRef,
    focusReturnFallback,
}: BaseModalProps) {
    const { theme } = useUnistyles();
    // A bottom sheet that closes on its scrim also closes by dragging it down (its frame draws the grabber).
    const sheetDismiss = placement === 'bottom' && closeOnBackdrop && onClose ? onClose : null;
    const webContentShellRef = React.useRef<HTMLDivElement | null>(null);
    const nativeScrollRef = React.useRef<ScrollView | null>(null);
    // The page behind a modal is never what a list inside it scrolls: its content follows the modal's own overlay
    // scroller, or none when the content owns its scrolling (the card body can still register its own).
    const scrollSourceRef = scrollHost === 'overlay' ? (isWeb ? webContentShellRef : nativeScrollRef) : null;
    const sheetChildren = (
        <PopoverScrollSourceProvider scrollSourceRef={scrollSourceRef}>
            <SheetDismissProvider onDismiss={sheetDismiss}>{children}</SheetDismissProvider>
        </PopoverScrollSourceProvider>
    );
    const scrimFrost = useFloatingScrimFrost();
    const insets = useChromeSafeAreaInsets();
    const [nativeViewportSize, setNativeViewportSize] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const onNativeViewportLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setNativeViewportSize(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    }, []);
    const nativeContentViewport = React.useMemo(() => nativeViewportSize ? {
        ...nativeViewportSize,
        bottomInset: placement === 'center' ? 0 : insets.bottom,
    } : null, [nativeViewportSize, placement, insets.bottom]);
    const baseZ = zIndexBase ?? MODAL_Z_INDEX;
    const inheritedWebPortalTarget = useModalPortalTarget();
    const [modalPortalTarget, setModalPortalTarget] = React.useState<HTMLElement | null>(null);
    const modalPortalHostRef = React.useRef<HTMLDivElement | null>(null);
    const radixDismissableLayer = React.useMemo(() => (isWeb ? requireRadixDismissableLayer() : null), []);
    const radixFocusScope = React.useMemo(() => (isWeb ? requireRadixFocusScope() : null), []);
    const modalMotionPreset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'modal' }),
        [],
    );
    const modalMotion = useOverlayMotionAnimation({
        visible,
        disabled: motion === 'none',
        preset: modalMotionPreset,
    });
    const modalPresence = useOverlayPresence(
        visible,
        modalMotion.exitMs,
    );
    const scrimOpacity = modalMotion.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 1],
    });
    const modalAccessibilityLabel = accessibilityLabel ?? t('common.dialog');
    const modalPointerEvents = resolveOverlayPointerEvents(visible ? 'auto' : 'none');
    const interactivePointerEvents = resolveOverlayPointerEvents('auto');
    const nativeContent = (
        <View
            pointerEvents={interactivePointerEvents.nativePointerEvents}
            style={[styles.scrollContentInner, placement === 'fullscreen' ? styles.contentFullscreen : null, interactivePointerEvents.webStyle]}
        >
            {sheetChildren}
        </View>
    );

    useWebOverlayFocusContainment({
        active: isWeb && visible && modalPresence.present,
        containerRef: webContentShellRef,
        focusReturn: focusReturnRef
            ? { kind: 'provided', ref: focusReturnRef, fallback: focusReturnFallback }
            : BASE_MODAL_FOCUS_RETURN,
    });
    const restoreNativeFocus = useRestoreFocusToTrigger(focusReturnRef);
    useEffect(() => {
        if (isWeb || !visible) return;
        return () => { restoreNativeFocus(); };
    }, [restoreNativeFocus, visible]);

    // On web, avoid setting React state inside a callback ref. In some browser/portal scenarios,
    // ref attach/detach churn can lead to nested update loops ("Maximum update depth exceeded").
    useLayoutEffect(() => {
        if (!isWeb) return;
        if (!visible) return;
        const node = modalPortalHostRef.current;
        if (!node) return;
        setModalPortalTarget((prev) => prev ?? node);
    }, [visible]);

    const goBack = onBack ?? onClose;
    const escapeLayer = useEscapeLayer({
        enabled: isWeb && visible && Boolean(goBack),
        priority: ESCAPE_LAYER_PRIORITIES.modal,
        allowEditableTarget: true,
        onEscape: () => { goBack?.(); },
    });

    useEffect(() => {
        if (isWeb) return;
        if (!visible || !goBack) return;

        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            goBack();
            return true;
        });

        return () => {
            subscription.remove();
        };
    }, [goBack, visible]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    if (isWeb) {
        if (!modalPresence.present) return null;

        const resolvedWebPortalTarget: ModalPortalTarget = (() => {
            if (webPortalTarget) return webPortalTarget;
            return resolveModalWebPortalTarget(inheritedWebPortalTarget, typeof document === 'undefined' ? null : document.body ?? null);
        })();

        const { Branch: DismissableLayerBranch, Root: DismissableLayer } = radixDismissableLayer!;
        const { Root: FocusScope } = radixFocusScope!;
        // Route modals (Expo Router's web modal, e.g. Settings) are Radix dialogs. Joining the same
        // Radix stacks makes this dialog the topmost overlay while it is shown: its layer is the
        // highest, so Escape reaches only it (it closes through its own handler below, hence no
        // `onDismiss`), and its focus scope pauses the route modal's focus trap, which would otherwise
        // pull focus back out of it. Focus placement and return stay with the containment hook.
        const focusEntryIntoShell = (event: Event) => {
            event.preventDefault();
            webContentShellRef.current?.focus({ preventScroll: true });
        };
        const leaveFocusReturnToContainment = (event: Event) => {
            event.preventDefault();
        };

        // Leaving, the scrim fades on the same curve as the surface's own fade, so the page clears with it.
        const scrimTiming = visible
            ? `${motionTokens.overlay.modal.enterMs}ms cubic-bezier(0.2, 0, 0, 1)`
            : `${motionTokens.overlay.modal.exitMs}ms ${motionTokens.easingCss.exit}`;
        const overlayStyle: React.CSSProperties = {
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: baseZ,
            transition: motion === 'none' ? undefined : [
                `background-color ${scrimTiming}`,
                ...(scrimFrost
                    ? [
                        `backdrop-filter ${scrimTiming}`,
                        `-webkit-backdrop-filter ${scrimTiming}`,
                    ]
                    : []),
            ].join(', '),
            // The one popover/sheet scrim (0.2): a light frost under a very light dim.
            ...createFloatingScrimWebStyle({ scrim: theme.colors.overlay.scrim, frost: scrimFrost, visible }),
        };

        const contentStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            outline: 'none',
            zIndex: baseZ + 1,
            overflowY: scrollHost === 'overlay' ? 'auto' : 'hidden',
        };

        const portalHostStyle: React.CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            overflow: 'visible',
        };

        const topPlacementGap = theme.space.s24 * 2;
        const autoPlacementContainerStyle = {
            // Auto-placement:
            // - content <= viewport ⇒ container height is 100% ⇒ centered
            // - content > viewport  ⇒ container height grows with content ⇒ naturally top-aligned
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: placement === 'fullscreen' ? 'flex-start' : placement === 'bottom' ? 'flex-end' : webPlacement === 'top' ? 'flex-start' : 'center',
            alignItems: placement !== 'center' ? 'stretch' : 'center',
            // A command surface (⌘K, Browse) floats in the upper third, Spotlight-style, not under the title strip:
            // a share of the window's height, never less than the fixed gap.
            paddingTop: placement === 'fullscreen' ? 0 : webPlacement === 'top' ? `max(${Math.max(insets.top, topPlacementGap)}px, ${COMMAND_SURFACE_TOP_SHARE_VH}vh)` : insets.top,
            // A bottom sheet reaches the edge; it pads the safe area inside itself.
            paddingBottom: placement !== 'center' ? 0 : webPlacement === 'top' ? Math.max(insets.bottom, topPlacementGap) : insets.bottom,
            paddingLeft: placement === 'fullscreen' ? 0 : insets.left,
            paddingRight: placement === 'fullscreen' ? 0 : insets.right,
            boxSizing: 'border-box',
        } as unknown as ViewStyle;

        const webModalCardBoundaryStyle = {
            display: 'contents',
        } as unknown as ViewStyle;

        const topPlacementContentStyle = webPlacement === 'top'
            ? ({
                flex: 1,
                minHeight: '100%',
                alignSelf: 'stretch',
                alignItems: 'stretch',
            } as unknown as ViewStyle)
            : null;

        const webModalNode = (
            <EscapeLayerProvider layer={escapeLayer}>
                {showBackdrop ? (
                    <Animated.View
                        testID="modal-scrim"
                        pointerEvents={modalPointerEvents.nativePointerEvents}
                        style={[
                            overlayStyle as unknown as ViewStyle,
                            modalPointerEvents.webStyle,
                        ]}
                        {...(webEventHandlers as any)}
                    />
                ) : null}
                <DismissableLayerBranch style={{ display: 'contents' }}>
                    <DismissableLayer asChild>
                    <FocusScope
                        asChild
                        onMountAutoFocus={focusEntryIntoShell}
                        onUnmountAutoFocus={leaveFocusReturnToContainment}
                    >
                    <div
                        ref={webContentShellRef}
                        role="dialog"
                        data-testid={testID}
                        data-happy-modal-layer=""
                        aria-modal="true"
                        aria-label={modalAccessibilityLabel}
                        tabIndex={-1}
                        style={{ ...contentStyle, pointerEvents: visible ? 'auto' : 'none' }}
                        onPointerDown={stopPropagation}
                        onTouchStart={stopPropagation}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!closeOnBackdrop || !onClose) return;
                            // Close when the click lands outside the modal card boundary.
                            // The dialog content spans the viewport, so clicks on that shell are treated as backdrop clicks.
                            if (isInsideWebModalCardBoundary(e.target)) return;

                            e.preventDefault();
                            e.stopPropagation();
                            onClose();
                        }}
                    >
                        <div style={visuallyHiddenDomStyle}>{modalAccessibilityLabel}</div>
                        {/* Host for web portals (e.g. popovers) that must live inside the dialog subtree. */}
                        <div
                            data-happy-modal-portal-host=""
                            data-happy-modal-card-boundary=""
                            ref={modalPortalHostRef}
                            style={portalHostStyle}
                        />
                        <ModalPortalTargetProvider target={modalPortalTarget} layerZIndex={baseZ + 1}>
                            <ModalBoundaryProvider>
                                <KeyboardAwareModalFrame
                                    pointerEvents={interactivePointerEvents.nativePointerEvents}
                                    style={[
                                        styles.container,
                        placement === 'bottom' ? styles.containerBottom : null,
                                        autoPlacementContainerStyle,
                                        interactivePointerEvents.webStyle,
                                    ]}
                                >
                                    <ModalContentFrame
                                        motion={motion}
                                        visible={visible}
                                        kind="modal"
                                        direction={placement === 'bottom' ? 'bottom' : undefined}
                                        pointerEvents={visible ? 'auto' : 'none'}
                                        style={[
                                            styles.content,
                                            topPlacementContentStyle,
                                            placement === 'fullscreen' ? styles.contentFullscreen : null,
                                        ]}
                                    >
                                        <View
                                            pointerEvents={interactivePointerEvents.nativePointerEvents}
                                            {...({ dataSet: { happyModalCardBoundary: 'true' } } as unknown as Record<string, unknown>)}
                                            style={[
                                                webModalCardBoundaryStyle as unknown as ViewStyle,
                                                interactivePointerEvents.webStyle,
                                            ]}
                                        >
                                            {sheetChildren}
                                        </View>
                                    </ModalContentFrame>
                                </KeyboardAwareModalFrame>
                            </ModalBoundaryProvider>
                        </ModalPortalTargetProvider>
                    </div>
                    </FocusScope>
                    </DismissableLayer>
                </DismissableLayerBranch>
            </EscapeLayerProvider>
        );

        if (resolvedWebPortalTarget) {
            try {
                const ReactDOM = requireReactDOM();
                if (ReactDOM?.createPortal) {
                    return ReactDOM.createPortal(webModalNode, resolvedWebPortalTarget);
                }
            } catch {
                // Fall back to inline rendering if the portal target is unusable in the current runtime.
            }
        }

        return webModalNode;
    }

    // IMPORTANT:
    // On iOS, stacking native modals (expo-router / react-navigation modal screens + RN <Modal>)
    // can lead to the RN modal rendering behind the navigation modal, while still blocking touches.
    // To avoid this, we render "portal style" overlays on native (no RN <Modal>).
    if (!modalPresence.present) return null;

    return (
        <View
            style={[
                styles.portalRoot,
                { zIndex: baseZ, elevation: baseZ },
                modalPointerEvents.webStyle,
            ]}
            pointerEvents={modalPointerEvents.nativePointerEvents}
            role="dialog"
            testID={testID}
            accessibilityLabel={modalAccessibilityLabel}
            accessibilityViewIsModal={visible}
        >
            <OverlayPortalProvider>
                <KeyboardAwareModalFrame
                    style={styles.container}
                    contentContainerStyle={[
                        styles.container,
                        placement === 'bottom' ? styles.containerBottom : null,
                        {
                            // Keyboard-controller owns the outer paddingBottom animation.
                            // Keep safe-area padding on its ordinary content View.
                            alignSelf: 'stretch',
                            paddingTop: placement === 'fullscreen' ? 0 : insets.top,
                            paddingRight: placement === 'fullscreen' ? 0 : insets.right,
                            paddingBottom: placement !== 'center' ? 0 : insets.bottom,
                            paddingLeft: placement === 'fullscreen' ? 0 : insets.left,
                        },
                    ]}
                    {...webEventHandlers}
                >
                    {showBackdrop ? (
                        <TouchableWithoutFeedback onPress={handleBackdropPress}>
                            {/* The one popover/sheet scrim (0.2): a light frost under a very light dim; only its wrapper fades. */}
                            <Animated.View style={[styles.backdrop, { opacity: scrimOpacity }]}>
                                <FloatingScrim testID="modal-scrim" style={StyleSheet.absoluteFillObject} />
                            </Animated.View>
                        </TouchableWithoutFeedback>
                    ) : null}

                    <ModalContentFrame
                        motion={motion}
                        visible={visible}
                        kind="modal"
                        direction={placement === 'bottom' ? 'bottom' : undefined}
                        // A card or sheet stands on glass: it moves in by transform alone, since UIKit renders no glass
                        // created under an ancestor below full alpha (NATIVE-SWEEP M2: a clear Sign-in card). Its scrim fades.
                        material={placement !== 'fullscreen'}
                        pointerEvents="box-none"
                        style={[
                            styles.content,
                            placement === 'fullscreen' ? styles.contentFullscreen : null,
                        ]}
                    >
                        <ModalBoundaryProvider viewport={nativeContentViewport}>
                            {/* Keep the body's native parent when chrome transfers scroll ownership. */}
                            <ScrollView
                                ref={nativeScrollRef}
                                onLayout={onNativeViewportLayout}
                                style={styles.scrollContainer}
                                contentContainerStyle={[styles.scrollContent, placement === 'bottom' ? styles.scrollContentBottom : null]}
                                scrollEnabled={scrollHost === 'overlay'}
                                showsVerticalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                centerContent={placement === 'center'}
                            >
                                {/* A disabled host retains input custody without advertising a scroll ancestor to
                                    native lists. A scrolling body below supplies its own context; an overlay keeps this one. */}
                                {NativeScrollContext ? (
                                    <NativeScrollContext.Consumer>{context => (
                                        <NativeScrollContext.Provider value={scrollHost === 'overlay' ? context : null}>
                                            {nativeContent}
                                        </NativeScrollContext.Provider>
                                    )}</NativeScrollContext.Consumer>
                                ) : nativeContent}
                            </ScrollView>
                        </ModalBoundaryProvider>
                    </ModalContentFrame>
                    <OverlayPortalHost />
                </KeyboardAwareModalFrame>
            </OverlayPortalProvider>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    portalRoot: {
        ...StyleSheet.absoluteFillObject,
        zIndex: MODAL_Z_INDEX,
        elevation: MODAL_Z_INDEX,
    },
      container: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          // On web, ensure modal can receive pointer events when body has pointer-events: none
          ...Platform.select({ web: { pointerEvents: 'auto' as const } })
      },
    containerBottom: {
        justifyContent: 'flex-end',
        alignItems: 'stretch',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'transparent',
    },
    content: {
        zIndex: 1,
        // On web, some modal children use percentage widths; ensure they center reliably.
        width: '100%',
        alignItems: 'center',
        ...Platform.select({
            web: {},
            default: { flex: 1 },
        }),
    },
    scrollContainer: {
        width: '100%',
        flex: 1,
        alignSelf: 'stretch',
    },
    contentFullscreen: {
        flex: 1,
        alignSelf: 'stretch',
        alignItems: 'stretch',
    },
    scrollContent: {
        flexGrow: 1,
        alignItems: 'stretch',
        justifyContent: 'center',
    },
    scrollContentBottom: {
        justifyContent: 'flex-end',
    },
    scrollContentInner: {
        width: '100%',
        alignItems: 'center',
    },
}));
