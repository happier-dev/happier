import React, { useEffect } from 'react';
import {
    View,
    TouchableWithoutFeedback,
    Animated,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { requireRadixDialog, requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import type { ModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { t } from '@/text';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import {
    OverlayMotionFrame,
    resolveOverlayMotionPreset,
    useOverlayMotionAnimation,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { motionTokens } from '@/components/ui/motion/motionTokens';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};
const WEB_MODAL_CARD_BOUNDARY_SELECTOR = '[data-happy-modal-card-boundary]';
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
    webPortalTarget?: ModalPortalTarget;
}

function createWebModalPortalTarget(): HTMLElement | null {
    if (Platform.OS !== 'web') return null;
    if (typeof document === 'undefined') return null;
    if (typeof document.createElement !== 'function') return null;

    const target = document.createElement('div');
    target.setAttribute('data-happy-modal-portal-target', '');
    Object.assign(target.style, {
        position: 'absolute',
        top: '0px',
        left: '0px',
        width: '0px',
        height: '0px',
        overflow: 'visible',
    } satisfies Partial<CSSStyleDeclaration>);
    return target;
}

export function BaseModal({
    visible,
    onClose,
    children,
    closeOnBackdrop = true,
    showBackdrop = true,
    zIndexBase,
    webPortalTarget = null,
}: BaseModalProps) {
    const { theme } = useUnistyles();
    const baseZ = zIndexBase ?? 100000;
    const modalMotionPreset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'modal' }),
        [],
    );
    const modalMotion = useOverlayMotionAnimation({
        visible,
        preset: modalMotionPreset,
    });
    const modalPresence = useOverlayPresence(visible, modalMotion.exitMs);
    const backdropOpacity = modalMotion.progress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, motionTokens.overlay.modal.backdropMaxOpacity],
    });
    const modalPortalTargetRef = React.useRef<HTMLElement | null>(null);
    if (modalPortalTargetRef.current == null) {
        modalPortalTargetRef.current = createWebModalPortalTarget();
    }
    const modalPortalHostRef = React.useRef<HTMLElement | null>(null);
    const setModalPortalHostRef = React.useCallback((node: HTMLElement | null) => {
        const target = modalPortalTargetRef.current;
        const previousHost = modalPortalHostRef.current;
        if (previousHost === node) return;

        if (target && previousHost) {
            try {
                previousHost.removeChild(target);
            } catch {
                // ignore detach failures during ref cleanup
            }
        }

        modalPortalHostRef.current = node;

        if (target && node) {
            try {
                node.appendChild(target);
            } catch {
                // ignore attach failures and fall back to inline rendering
            }
        }
    }, []);

    useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!visible) return;

        return installWebModalBodyPointerEventsBypass();
    }, [visible]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    if (Platform.OS === 'web') {
        if (!modalPresence.present) return null;

        // IMPORTANT:
        // Use the CJS entrypoints (`require`) so Radix singletons (DismissableLayer / FocusScope stacks)
        // are shared with Vaul / expo-router on web. With Metro, mixing ESM+CJS builds can lead to
        // duplicate Radix modules and broken stacking/focus behavior.
        const Dialog = requireRadixDialog();
        const { Branch: DismissableLayerBranch } = requireRadixDismissableLayer();

        const overlayStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            zIndex: baseZ,
            transition: [
                `background-color ${visible ? motionTokens.overlay.modal.enterMs : motionTokens.overlay.modal.exitMs}ms cubic-bezier(0.2, 0, 0, 1)`,
                `backdrop-filter ${visible ? motionTokens.overlay.modal.enterMs : motionTokens.overlay.modal.exitMs}ms cubic-bezier(0.2, 0, 0, 1)`,
                `-webkit-backdrop-filter ${visible ? motionTokens.overlay.modal.enterMs : motionTokens.overlay.modal.exitMs}ms cubic-bezier(0.2, 0, 0, 1)`,
            ].join(', '),
            ...createBackdropWebStyle({
                backgroundColor: visible ? (theme.colors.overlay.scrimWizard ?? theme.colors.overlay.scrim) : 'transparent',
                blurPx: visible ? 2 : 0,
            }),
        };

        const contentStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            outline: 'none',
            zIndex: baseZ + 1,
        };

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

        const webModalCardBoundaryStyle: React.CSSProperties = {
            display: 'contents',
        };

        return (
            <Dialog.Root
                open={modalPresence.present}
                onOpenChange={(open) => {
                    if (!open && visible && onClose) onClose();
                }}
              >
                  <Dialog.Portal container={(webPortalTarget ?? undefined) as any}>
                      {showBackdrop ? (
                          <Dialog.Overlay
                              style={overlayStyle}
                              onClick={stopPropagation}
                              onPointerDown={stopPropagation}
                              onTouchStart={stopPropagation}
                          />
                      ) : null}
                      <DismissableLayerBranch style={{ display: 'contents' }}>
                          <Dialog.Content
                              aria-describedby={undefined}
                              style={contentStyle}
                              onPointerDown={stopPropagation}
                              onTouchStart={stopPropagation}
                              onClick={(e) => {
                                  e.stopPropagation();
                                  if (!closeOnBackdrop || !onClose) return;
                                  // Close when the click lands outside the modal card boundary.
                                  // The centering shell spans the viewport, so clicks on that shell are treated as backdrop clicks.
                                  if (isInsideWebModalCardBoundary(e.target)) return;

                                  e.preventDefault();
                                  e.stopPropagation();
                                  onClose();
                              }}
                            onPointerDownOutside={
                                closeOnBackdrop ? undefined : (e) => e.preventDefault()
                            }
                        >
                              <Dialog.Title style={visuallyHiddenStyle}>{t('common.dialog')}</Dialog.Title>
                            {/* Host for web portals (e.g. popovers) that must live inside the dialog subtree. */}
                            <div
                                data-happy-modal-portal-host=""
                                ref={setModalPortalHostRef}
                                style={portalHostStyle}
                            />
                            <ModalPortalTargetProvider target={modalPortalTargetRef.current}>
                                <ModalBoundaryProvider>
                                    <KeyboardAvoidingView
                                        pointerEvents="auto"
                                        style={styles.container}
                                        behavior={undefined}
                                    >
                                        <Animated.View
                                            pointerEvents="auto"
                                            style={[
                                                styles.content,
                                                modalMotion.style,
                                            ]}
                                        >
                                            <div
                                                data-happy-modal-card-boundary=""
                                                style={webModalCardBoundaryStyle}
                                            >
                                                {children}
                                            </div>
                                        </Animated.View>
                                    </KeyboardAvoidingView>
                                </ModalBoundaryProvider>
                            </ModalPortalTargetProvider>
                        </Dialog.Content>
                    </DismissableLayerBranch>
                </Dialog.Portal>
            </Dialog.Root>
        );
    }

    // IMPORTANT:
    // On iOS, stacking native modals (expo-router / react-navigation modal screens + RN <Modal>)
    // can lead to the RN modal rendering behind the navigation modal, while still blocking touches.
    // To avoid this, we render "portal style" overlays on native (no RN <Modal>).
      if (!modalPresence.present) return null;

      return (
          <View style={[styles.portalRoot, { zIndex: baseZ, elevation: baseZ }]} pointerEvents={visible ? 'auto' : 'none'}>
              <KeyboardAvoidingView
                  style={styles.container}
                  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                  {...webEventHandlers}
            >
                {showBackdrop ? (
                    <TouchableWithoutFeedback onPress={handleBackdropPress}>
                        <Animated.View
                            style={[
                                styles.backdrop,
                                {
                                    ...createBackdropNativeStyle({
                                        backgroundColor: theme.colors.overlay.scrimWizard ?? theme.colors.overlay.scrim,
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
                        <View pointerEvents="auto" style={{ width: '100%', alignItems: 'center' }}>
                            {children}
                        </View>
                    </ModalBoundaryProvider>
                </OverlayMotionFrame>
            </KeyboardAvoidingView>
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
    }
}));
