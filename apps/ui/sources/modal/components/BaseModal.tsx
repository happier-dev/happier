import React, { useEffect, useRef } from 'react';
import {
    View,
    TouchableWithoutFeedback,
    Animated,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { requireRadixDialog, requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import { t } from '@/text';

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
}

export function BaseModal({
    visible,
    onClose,
    children,
    closeOnBackdrop = true,
    showBackdrop = true,
    zIndexBase,
}: BaseModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const baseZ = zIndexBase ?? 100000;
    const [modalPortalTarget, setModalPortalTarget] = React.useState<HTMLElement | null>(null);

    useEffect(() => {
        const useNativeDriver = Platform.OS !== 'web';
        if (visible) {
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver,
            }).start();
        } else {
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 200,
                useNativeDriver,
            }).start();
        }
    }, [visible, fadeAnim]);

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
        if (!visible) return null;

        // IMPORTANT:
        // Use the CJS entrypoints (`require`) so Radix singletons (DismissableLayer / FocusScope stacks)
        // are shared with Vaul / expo-router on web. With Metro, mixing ESM+CJS builds can lead to
        // duplicate Radix modules and broken stacking/focus behavior.
        const Dialog = requireRadixDialog();
        const { Branch: DismissableLayerBranch } = requireRadixDismissableLayer();

        const overlayStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: baseZ,
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
                open={visible}
                onOpenChange={(open) => {
                    if (!open && onClose) onClose();
                }}
              >
                  <Dialog.Portal>
                      {showBackdrop ? (
                          <Dialog.Overlay
                              style={overlayStyle}
                              onClick={stopPropagation}
                              onPointerDown={stopPropagation}
                              onTouchStart={stopPropagation}
                          />
                      ) : null}
                      <DismissableLayerBranch asChild>
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
                                ref={(node) => {
                                    setModalPortalTarget((prev) => (prev === node ? prev : node));
                                }}
                                style={portalHostStyle}
                            />
                            <ModalPortalTargetProvider target={modalPortalTarget}>
                                <KeyboardAvoidingView
                                    pointerEvents="auto"
                                    style={styles.container}
                                    behavior={undefined}
                                >
                                    <Animated.View
                                        pointerEvents="auto"
                                        style={[
                                            styles.content,
                                            {
                                                opacity: fadeAnim,
                                                transform: [{
                                                    scale: fadeAnim.interpolate({
                                                        inputRange: [0, 1],
                                                        outputRange: [0.9, 1]
                                                    })
                                                }]
                                            }
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
      if (!visible) return null;

      return (
          <View style={[styles.portalRoot, { zIndex: baseZ, elevation: baseZ }]} pointerEvents="auto">
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
                                    opacity: fadeAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0, 0.5]
                                    })
                                }
                            ]}
                        />
                    </TouchableWithoutFeedback>
                ) : null}

                <Animated.View
                    pointerEvents="box-none"
                    style={[
                        styles.content,
                        {
                            opacity: fadeAnim,
                            transform: [{
                                scale: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0.9, 1]
                                })
                            }]
                        }
                    ]}
                >
                    <View pointerEvents="auto" style={{ width: '100%', alignItems: 'center' }}>
                        {children}
                    </View>
                </Animated.View>
            </KeyboardAvoidingView>
        </View>
    );
}

const styles = StyleSheet.create({
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
        backgroundColor: 'black'
    },
    content: {
        zIndex: 1,
        // On web, some modal children use percentage widths; ensure they center reliably.
        width: '100%',
        alignItems: 'center',
    }
});
