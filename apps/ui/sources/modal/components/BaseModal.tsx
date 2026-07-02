import React, { useEffect, useLayoutEffect } from 'react';
import { View, TouchableWithoutFeedback, Animated, Platform, ScrollView, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { KeyboardAwareModalFrame } from '@/components/ui/keyboardAvoidance';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';
import { requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { requireReactDOM } from '@/utils/web/reactDomCjs';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import {
    OverlayMotionFrame,
    resolveOverlayMotionPreset,
    useOverlayMotionAnimation,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const isWeb = String(Platform.OS) === 'web';
const WEB_MODAL_CARD_BOUNDARY_SELECTOR = '[data-happy-modal-card-boundary]';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = isWeb
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};
const WEB_MODAL_BODY_POINTER_EVENTS_STATE_KEY = '__happyWebModalBodyPointerEventsState';

type WebModalBodyPointerEventsState = {
    activeCount: number;
    observer: MutationObserver | null;
    previousInlinePointerEvents: string;
};

function getWebModalBodyPointerEventsState(): WebModalBodyPointerEventsState {
    const globalObject = globalThis as typeof globalThis & {
        [WEB_MODAL_BODY_POINTER_EVENTS_STATE_KEY]?: WebModalBodyPointerEventsState;
    };

    const existing = globalObject[WEB_MODAL_BODY_POINTER_EVENTS_STATE_KEY];
    if (existing) return existing;

    const nextState: WebModalBodyPointerEventsState = {
        activeCount: 0,
        observer: null,
        previousInlinePointerEvents: '',
    };
    globalObject[WEB_MODAL_BODY_POINTER_EVENTS_STATE_KEY] = nextState;
    return nextState;
}

function setWebModalBodyPointerEventsAuto(doc: Document): void {
    if (doc.body?.style == null) return;
    if (doc.body.style.pointerEvents !== 'auto') {
        doc.body.style.pointerEvents = 'auto';
    }
}

function installWebModalBodyPointerEventsBypass(): () => void {
    if (typeof document === 'undefined' || document.body?.style == null) {
        return () => {};
    }

    const doc = document;
    const state = getWebModalBodyPointerEventsState();

    if (state.activeCount === 0) {
        state.previousInlinePointerEvents = doc.body.style.pointerEvents ?? '';
        setWebModalBodyPointerEventsAuto(doc);

        if (typeof MutationObserver !== 'undefined') {
            state.observer = new MutationObserver(() => {
                if (state.activeCount <= 0) return;
                setWebModalBodyPointerEventsAuto(doc);
            });
            state.observer.observe(doc.body, {
                attributes: true,
                attributeFilter: ['style'],
            });
        }
    }

    state.activeCount += 1;

    return () => {
        const currentState = getWebModalBodyPointerEventsState();
        currentState.activeCount = Math.max(0, currentState.activeCount - 1);

        if (currentState.activeCount > 0) {
            setWebModalBodyPointerEventsAuto(doc);
            return;
        }

        currentState.observer?.disconnect();
        currentState.observer = null;
        doc.body.style.pointerEvents = currentState.previousInlinePointerEvents;
        currentState.previousInlinePointerEvents = '';
    };
}

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
    children: React.ReactNode;
    closeOnBackdrop?: boolean;
    showBackdrop?: boolean;
    zIndexBase?: number;
    webPlacement?: 'auto' | 'top';
    webPortalTarget?: ModalPortalTarget;
}

export function BaseModal({
    visible,
    onClose,
    children,
    closeOnBackdrop = true,
    showBackdrop = true,
    zIndexBase,
    webPlacement = 'auto',
    webPortalTarget = null,
}: BaseModalProps) {
    const { theme } = useUnistyles();
    const uiBackdropBlurEnabled = useLocalSetting('uiBackdropBlurEnabled') !== false;
    const insets = useChromeSafeAreaInsets();
    const baseZ = zIndexBase ?? 100000;
    const [modalPortalTarget, setModalPortalTarget] = React.useState<HTMLElement | null>(null);
    const modalPortalHostRef = React.useRef<HTMLDivElement | null>(null);
    const radixDismissableLayer = React.useMemo(() => (isWeb ? requireRadixDismissableLayer() : null), []);
    const webContentShellRef = React.useRef<HTMLDivElement | null>(null);
    const webPreviousActiveElementRef = React.useRef<HTMLElement | null>(null);
    const modalMotionPreset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'modal' }),
        [],
    );
    const modalMotion = useOverlayMotionAnimation({
        visible,
        preset: modalMotionPreset,
    });
    const modalPresence = useOverlayPresence(
        visible,
        modalMotion.exitMs,
    );
    const backdropOpacity = modalMotion.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, motionTokens.overlay.modal.backdropMaxOpacity],
    });

    // On web, avoid setting React state inside a callback ref. In some browser/portal scenarios,
    // ref attach/detach churn can lead to nested update loops ("Maximum update depth exceeded").
    useLayoutEffect(() => {
        if (!isWeb) return;
        if (!visible) return;
        const node = modalPortalHostRef.current;
        if (!node) return;
        setModalPortalTarget((prev) => prev ?? node);
    }, [visible]);

    useEffect(() => {
        if (!isWeb) return;
        if (!visible) return;

        return installWebModalBodyPointerEventsBypass();
    }, [visible]);

    useEffect(() => {
        if (!isWeb) return;
        if (!visible) return;
        if (typeof document === 'undefined') return;

        webPreviousActiveElementRef.current = (document.activeElement as HTMLElement | null) ?? null;

        // Move focus into the modal shell so Escape/Tab interactions behave predictably.
        // Avoid forcing focus if the shell ref isn't ready yet.
        const shell = webContentShellRef.current;
        if (shell) {
            try {
                shell.focus();
            } catch {
                // ignore
            }
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            if (!onClose) return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            const previous = webPreviousActiveElementRef.current;
            webPreviousActiveElementRef.current = null;
            if (previous && typeof previous.focus === 'function') {
                try {
                    previous.focus();
                } catch {
                    // ignore
                }
            }
        };
    }, [onClose, visible]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    if (isWeb) {
        if (!modalPresence.present) return null;

        const resolvedWebPortalTarget: ModalPortalTarget = (() => {
            if (webPortalTarget) return webPortalTarget;
            if (typeof document === 'undefined') return null;
            return document.body ?? null;
        })();

        const { Branch: DismissableLayerBranch } = radixDismissableLayer!;

        const overlayStyle: React.CSSProperties = {
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: baseZ,
            transition: [
                `background-color ${visible ? motionTokens.overlay.modal.enterMs : motionTokens.overlay.modal.exitMs}ms cubic-bezier(0.2, 0, 0, 1)`,
                ...(uiBackdropBlurEnabled
                    ? [
                        `backdrop-filter ${visible ? motionTokens.overlay.modal.enterMs : motionTokens.overlay.modal.exitMs}ms cubic-bezier(0.2, 0, 0, 1)`,
                        `-webkit-backdrop-filter ${visible ? motionTokens.overlay.modal.enterMs : motionTokens.overlay.modal.exitMs}ms cubic-bezier(0.2, 0, 0, 1)`,
                    ]
                    : []),
            ].join(', '),
            ...createBackdropWebStyle({
                backgroundColor: visible
                    ? ((theme.colors.overlay.scrimWizard ?? theme.colors.overlay.scrim) as unknown as string)
                    : 'transparent',
                blurPx: visible ? 2 : 0,
                enableBlur: uiBackdropBlurEnabled,
                fallbackBackgroundColorWhenBlurDisabled: visible
                    ? ((theme.colors.overlay.scrimStrong ?? theme.colors.overlay.scrim) as unknown as string)
                    : 'transparent',
            }),
        };

        const contentStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            outline: 'none',
            zIndex: baseZ + 1,
            overflowY: 'auto',
        };

        const title = t('common.dialog');

        const visuallyHiddenStyle: React.CSSProperties = {
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            borderWidth: 0,
        };

        const portalHostStyle: React.CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            overflow: 'visible',
        };

        const autoPlacementContainerStyle = {
            // Auto-placement:
            // - content <= viewport ⇒ container height is 100% ⇒ centered
            // - content > viewport  ⇒ container height grows with content ⇒ naturally top-aligned
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: webPlacement === 'top' ? 'flex-start' : 'center',
            alignItems: 'center',
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
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
            <>
                {showBackdrop ? (
                    <Animated.View
                        pointerEvents={visible ? 'auto' : 'none'}
                        style={overlayStyle as unknown as ViewStyle}
                        {...(webEventHandlers as any)}
                    />
                ) : null}
                <DismissableLayerBranch style={{ display: 'contents' }}>
                    <div
                        ref={webContentShellRef}
                        role="dialog"
                        aria-modal="true"
                        aria-label={title}
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
                        <div style={visuallyHiddenStyle}>{title}</div>
                        {/* Host for web portals (e.g. popovers) that must live inside the dialog subtree. */}
                        <div
                            data-happy-modal-portal-host=""
                            data-happy-modal-card-boundary=""
                            ref={modalPortalHostRef}
                            style={portalHostStyle}
                        />
                        <ModalPortalTargetProvider target={modalPortalTarget}>
                            <ModalBoundaryProvider>
                                <KeyboardAwareModalFrame
                                    pointerEvents="auto"
                                    style={[styles.container, autoPlacementContainerStyle]}
                                >
                                    <OverlayMotionFrame
                                        visible={visible}
                                        kind="modal"
                                        pointerEvents={visible ? 'auto' : 'none'}
                                        style={[
                                            styles.content,
                                            topPlacementContentStyle,
                                        ]}
                                    >
                                        <View
                                            pointerEvents="auto"
                                            {...({ dataSet: { happyModalCardBoundary: 'true' } } as unknown as Record<string, unknown>)}
                                            style={webModalCardBoundaryStyle as unknown as any}
                                        >
                                            {children}
                                        </View>
                                    </OverlayMotionFrame>
                                </KeyboardAwareModalFrame>
                            </ModalBoundaryProvider>
                        </ModalPortalTargetProvider>
                    </div>
                </DismissableLayerBranch>
            </>
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
        <View style={[styles.portalRoot, { zIndex: baseZ, elevation: baseZ }]} pointerEvents={visible ? 'auto' : 'none'}>
            <OverlayPortalProvider>
                <KeyboardAwareModalFrame
                    style={[
                        styles.container,
                        {
                            paddingTop: insets.top,
                            paddingRight: insets.right,
                            paddingBottom: insets.bottom,
                            paddingLeft: insets.left,
                        },
                    ]}
                    {...webEventHandlers}
                >
                    {showBackdrop ? (
                        <TouchableWithoutFeedback onPress={handleBackdropPress}>
                            <Animated.View
                                style={[
                                    styles.backdrop,
                                    {
                                        ...createBackdropNativeStyle({
                                            backgroundColor: theme.colors.overlay.scrimWizard,
                                        }),
                                        opacity: backdropOpacity,
                                    }
                                ]}
                            />
                        </TouchableWithoutFeedback>
                    ) : null}

                    <OverlayMotionFrame
                        visible={visible}
                        kind="modal"
                        pointerEvents="box-none"
                        style={[
                            styles.content,
                        ]}
                    >
                        <ModalBoundaryProvider>
                            <ScrollView
                                style={styles.scrollContainer}
                                contentContainerStyle={styles.scrollContent}
                                showsVerticalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                centerContent={true}
                            >
                                <View pointerEvents="auto" style={styles.scrollContentInner}>
                                    {children}
                                </View>
                            </ScrollView>
                        </ModalBoundaryProvider>
                    </OverlayMotionFrame>
                    <OverlayPortalHost />
                </KeyboardAwareModalFrame>
            </OverlayPortalProvider>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    portalRoot: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 100000,
        elevation: 100000,
    },
      container: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          // On web, ensure modal can receive pointer events when body has pointer-events: none
          ...Platform.select({ web: { pointerEvents: 'auto' as const } })
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
    scrollContent: {
        flexGrow: 1,
        alignItems: 'stretch',
    },
    scrollContentInner: {
        width: '100%',
        alignItems: 'center',
    },
}));
