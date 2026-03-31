import React, { useEffect, useRef } from 'react';
import {
    View,
    TouchableWithoutFeedback,
    Animated,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { requireRadixDialog, requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { t } from '@/text';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';

const isWeb = String(Platform.OS) === 'web';

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

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
    closeOnBackdrop?: boolean;
    showBackdrop?: boolean;
    scrollable?: boolean;
    disableContentTransform?: boolean;
    zIndexBase?: number;
}

export function BaseModal({
    visible,
    onClose,
    children,
    closeOnBackdrop = true,
    showBackdrop = true,
    scrollable = false,
    disableContentTransform = false,
    zIndexBase,
}: BaseModalProps) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const baseZ = zIndexBase ?? 100000;
    const [modalPortalTarget, setModalPortalTarget] = React.useState<HTMLElement | null>(null);
    const setModalPortalHostRef = React.useCallback((node: HTMLElement | null) => {
        setModalPortalTarget((prev) => (prev === node ? prev : node));
    }, []);

    useEffect(() => {
        const useNativeDriver = !isWeb;
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
        if (!isWeb) return;
        if (!visible) return;

        return installWebModalBodyPointerEventsBypass();
    }, [visible]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    if (isWeb) {
        if (!visible) return null;

        // IMPORTANT:
        // Use the CJS entrypoints (`require`) so Radix singletons (DismissableLayer / FocusScope stacks)
        // are shared with Vaul / expo-router on web. With Metro, mixing ESM+CJS builds can lead to
        // duplicate Radix modules and broken stacking/focus behavior.
        const Dialog = requireRadixDialog();
        const { Branch: DismissableLayerBranch } = requireRadixDismissableLayer();

        const overlayStyle: React.CSSProperties = {
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: baseZ,
            ...createBackdropWebStyle({
                backgroundColor: theme.colors.overlay.scrimWizard as unknown as string,
                blurPx: 12,
            }),
        };

        const wantsFullscreenOverlay = disableContentTransform;
        const contentBackdropStyle: React.CSSProperties | null =
            !showBackdrop && wantsFullscreenOverlay
                ? createBackdropWebStyle({
                    backgroundColor: theme.colors.overlay.scrimWizard as unknown as string,
                    blurPx: 12,
                })
                : null;

        const contentStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            outline: 'none',
            zIndex: baseZ + 1,
            ...(scrollable ? { overflowY: 'auto' } : null),
            ...(contentBackdropStyle ?? null),
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
                      <DismissableLayerBranch style={{ display: 'contents' }}>
                          <Dialog.Content
                              aria-describedby={undefined}
                              style={contentStyle}
                              onPointerDown={stopPropagation}
                              onTouchStart={stopPropagation}
                              onClick={(e) => {
                                  e.stopPropagation();
                                  if (!closeOnBackdrop || !onClose) return;
                                  // The dialog content spans the viewport; treat clicks on the shell itself as backdrop clicks,
                                  // while preserving interactions within the modal content.
                                  if (e.target !== e.currentTarget) return;

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
                            <ModalPortalTargetProvider target={modalPortalTarget}>
                                <ModalBoundaryProvider>
                                    <KeyboardAvoidingView
                                        pointerEvents="auto"
                                        style={[
                                            styles.container,
                                            scrollable && isWeb ? styles.containerWebScrollHost : null,
                                            wantsFullscreenOverlay ? styles.containerFullscreenOverlay : null,
                                        ]}
                                        behavior={undefined}
                                    >
                                        {/*
                                          NOTE:
                                          On web, any ancestor with a CSS transform establishes a containing block for
                                          `position: fixed` descendants. Some full-viewport overlays (e.g. onboarding wizards)
                                          intentionally render fixed-position scrims inside the modal subtree. Allow opting
                                          out of the scale transform so those scrims can cover the full viewport.
                                        */}
                                        <Animated.View
                                            pointerEvents="auto"
                                            style={[
                                                styles.content,
                                                scrollable && isWeb ? styles.contentWebScrollHost : null,
                                                wantsFullscreenOverlay ? styles.contentFullscreenOverlay : null,
                                                {
                                                    opacity: fadeAnim,
                                                    ...(disableContentTransform
                                                        ? {}
                                                        : {
                                                            transform: [{
                                                                scale: fadeAnim.interpolate({
                                                                    inputRange: [0, 1],
                                                                    outputRange: [0.9, 1]
                                                                })
                                                            }]
                                                        }),
                                                }
                                            ]}
                                        >
                                            <View
                                                pointerEvents="auto"
                                                style={[
                                                    { width: '100%', alignItems: 'center' },
                                                    wantsFullscreenOverlay
                                                        ? { flex: 1, alignItems: 'stretch', minHeight: 0 }
                                                        : null,
                                                ]}
                                            >
                                                {children}
                                            </View>
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
      if (!visible) return null;

      return (
          <View style={[styles.portalRoot, { zIndex: baseZ, elevation: baseZ }]} pointerEvents="auto">
              <KeyboardAvoidingView
                  style={[
                      styles.container,
                      {
                          paddingTop: insets.top,
                          paddingBottom: insets.bottom,
                      },
                  ]}
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
                                    backgroundColor: theme.colors.overlay.scrimWizard,
                                }),
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
                            ...(disableContentTransform
                                ? {}
                                : {
                                    transform: [{
                                        scale: fadeAnim.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [0.9, 1]
                                        })
                                    }]
                                }),
                        }
                    ]}
                >
                    <ModalBoundaryProvider>
                        {scrollable ? (
                            <ScrollView
                                style={[
                                    styles.scrollContainer,
                                    disableContentTransform ? styles.scrollContainerFullscreen : null,
                                ]}
                                contentContainerStyle={[
                                    styles.scrollContent,
                                    disableContentTransform ? styles.scrollContentFullscreen : null,
                                ]}
                                showsVerticalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                            >
                                <View
                                    pointerEvents="auto"
                                    style={[
                                        { width: '100%', alignItems: 'center' },
                                        disableContentTransform ? { flex: 1, alignItems: 'stretch', minHeight: 0 } : null,
                                    ]}
                                >
                                    {children}
                                </View>
                            </ScrollView>
                        ) : (
                            <View
                                pointerEvents="auto"
                                style={[
                                    { width: '100%', alignItems: 'center' },
                                    disableContentTransform ? { flex: 1, alignItems: 'stretch', minHeight: 0 } : null,
                                ]}
                            >
                                {children}
                            </View>
                        )}
                    </ModalBoundaryProvider>
                </Animated.View>
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
    containerWebScrollHost: {
        flex: 0,
        flexGrow: 1,
        minHeight: '100%',
    },
    containerFullscreenOverlay: {
        justifyContent: 'flex-start',
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
        flex: 1,
        alignItems: 'center',
    },
    contentWebScrollHost: {
        flex: 0,
        flexGrow: 1,
    },
    contentFullscreenOverlay: {
        alignItems: 'stretch',
    },
    scrollContainer: {
        width: '100%',
        flex: 1,
        alignSelf: 'stretch',
    },
    scrollContainerFullscreen: {
        alignItems: 'stretch',
    },
    scrollContent: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    scrollContentFullscreen: {
        justifyContent: 'flex-start',
        alignItems: 'stretch',
    },
});
