import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { BackHandler, Platform } from 'react-native';
import { ModalConfig, ModalContextValue } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';

const ModalContext = createContext<ModalContextValue | undefined>(undefined);

type ModalProviderProps = Readonly<{
    active?: boolean;
    children: React.ReactNode;
}>;

type ModalHostEntry = ModalConfig & Readonly<{
    visible: boolean;
    focusReturnTarget: FocusReturnTarget;
}>;

type ModalHostState = Readonly<{
    modals: ModalHostEntry[];
}>;

export function useModal() {
    const context = useContext(ModalContext);
    if (!context) {
        throw new Error('useModal must be used within a ModalProvider');
    }
    return context;
}

export function useOptionalModal() {
    return useContext(ModalContext);
}

export function ModalProvider({ active = true, children }: ModalProviderProps) {
    const [state, setState] = useState<ModalHostState>({
        modals: []
    });
    const stateRef = React.useRef<ModalHostState>(state);
    const removalTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const pendingFocusReturnTargetsRef = React.useRef<FocusReturnTarget[]>([]);

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    useEffect(() => {
        const pendingTargets = pendingFocusReturnTargetsRef.current.splice(0);
        if (pendingTargets.length === 0) return;

        const target = pendingTargets[pendingTargets.length - 1];
        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        const hasNewConnectedFocus = activeElement
            && activeElement !== document.body
            && activeElement !== target
            && activeElement.isConnected !== false;
        if (hasNewConnectedFocus) return;

        restoreFocusToBestTarget({ current: target });
    }, [state.modals]);

    const clearRemovalTimer = useCallback((id: string) => {
        const timer = removalTimersRef.current.get(id);
        if (timer == null) return;
        clearTimeout(timer);
        removalTimersRef.current.delete(id);
    }, []);

    const removeModalNow = useCallback((id: string) => {
        clearRemovalTimer(id);
        const removedModal = stateRef.current.modals.find(modal => modal.id === id);
        if (removedModal) {
            pendingFocusReturnTargetsRef.current.push(removedModal.focusReturnTarget);
        }
        setState(prev => {
            const nextState = {
                modals: prev.modals.filter(modal => modal.id !== id)
            };
            stateRef.current = nextState;
            return nextState;
        });
    }, [clearRemovalTimer]);

    const generateId = useCallback(() => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }, []);

    const showModal = useCallback((config: Omit<ModalConfig, 'id'>): string => {
        const id = generateId();
        const focusReturnTarget = typeof document !== 'undefined'
            ? document.activeElement as FocusReturnTarget
            : null;
        const modalConfig = { ...config, id, visible: true, focusReturnTarget } as ModalHostEntry;
        clearRemovalTimer(id);
        
        setState(prev => {
            const nextState = {
                modals: [...prev.modals, modalConfig]
            };
            stateRef.current = nextState;
            return nextState;
        });
        
        return id;
    }, [clearRemovalTimer, generateId]);

    const hideModal = useCallback((id: string) => {
        const target = stateRef.current.modals.find(modal => modal.id === id);
        const shouldDelayRemoval = target?.type === 'custom' && target.visible;
        if (target && target.type !== 'custom') {
            pendingFocusReturnTargetsRef.current.push(target.focusReturnTarget);
        }

        setState(prev => {
            const currentTarget = prev.modals.find(modal => modal.id === id);
            if (!currentTarget) return prev;
            if (currentTarget.type !== 'custom') {
                const nextState = {
                    modals: prev.modals.filter(modal => modal.id !== id),
                };
                stateRef.current = nextState;
                return nextState;
            }

            const nextState = {
                modals: prev.modals.map((modal) => (
                    modal.id === id
                        ? { ...modal, visible: false }
                        : modal
                )),
            };
            stateRef.current = nextState;
            return nextState;
        });

        if (!shouldDelayRemoval) return;
        clearRemovalTimer(id);
        const timer = setTimeout(() => {
            removeModalNow(id);
        }, motionTokens.overlay.modal.exitMs);
        removalTimersRef.current.set(id, timer);
    }, [clearRemovalTimer, removeModalNow]);

    const hideAllModals = useCallback(() => {
        for (const timer of removalTimersRef.current.values()) {
            clearTimeout(timer);
        }
        removalTimersRef.current.clear();
        // The first modal owns the only opener that predates the stack. It remains authoritative
        // even while that modal is in its exit window; later openers live inside the stack and can
        // disconnect when hideAll removes every modal in the same commit.
        const rootModal = stateRef.current.modals[0];
        if (rootModal) {
            pendingFocusReturnTargetsRef.current.push(rootModal.focusReturnTarget);
        }
        const nextState = { modals: [] };
        stateRef.current = nextState;
        setState(nextState);
    }, []);

    const updateCustomModalProps = useCallback((id: string, props: Record<string, unknown>) => {
        setState((prev) => {
            const nextState = {
                modals: prev.modals.map((modal) => {
                    if (modal.id !== id || modal.type !== 'custom') {
                        return modal;
                    }

                    return {
                        ...modal,
                        props: {
                            ...(modal.props ?? {}),
                            ...props,
                        },
                    };
                }),
            };
            stateRef.current = nextState;
            return nextState;
        });
    }, []);

    // The single user-dismiss path for every modal type: backdrop, Escape, close button, injected
    // `onClose`, and Android back all resolve the modal's pending result the same way.
    const dismissModal = useCallback((modal: ModalConfig) => {
        if (modal.type === 'alert') {
            Modal.resolveAlert(modal.id);
        } else if (modal.type === 'confirm') {
            Modal.resolveConfirm(modal.id, false);
        } else if (modal.type === 'prompt') {
            Modal.resolvePrompt(modal.id, null);
        } else if (modal.type === 'custom') {
            try {
                modal.onRequestClose?.();
            } catch {
                // ignore
            }
        }
        hideModal(modal.id);
    }, [hideModal]);

    useEffect(() => {
        if (!active) {
            return undefined;
        }

        return Modal.registerProvider({
            showModal,
            hideModal,
            hideAllModals,
            updateCustomModalProps,
        });
    }, [active, showModal, hideModal, hideAllModals, updateCustomModalProps]);

    useEffect(() => {
        return () => {
            for (const timer of removalTimersRef.current.values()) {
                clearTimeout(timer);
            }
            removalTimersRef.current.clear();
        };
    }, []);

    const topVisibleIndex = state.modals.reduce((topIndex, modal, index) => (
        modal.visible ? index : topIndex
    ), -1);
    const hasVisibleModal = topVisibleIndex >= 0;

    // Android hardware back / back gesture dismisses the topmost visible modal with the same
    // semantics as Escape on web (`closeOnBackdrop` only gates backdrop taps). One listener for the
    // whole stack, held only while a modal is visible; it registers after navigation's listener,
    // so it wins React Native's newest-first dispatch and navigation never pops behind a modal.
    useEffect(() => {
        if (Platform.OS !== 'android' || !active || !hasVisibleModal) return undefined;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            const modals = stateRef.current.modals;
            for (let index = modals.length - 1; index >= 0; index -= 1) {
                const modal = modals[index];
                if (modal.visible) {
                    dismissModal(modal);
                    return true;
                }
            }
            return false;
        });
        return () => subscription.remove();
    }, [active, hasVisibleModal, dismissModal]);
    const zIndexStep = 10;
    const zIndexBase = 100000;
    const screenOverlayPortalZIndex = zIndexBase - 10000;
    const isKeyboardLiftSuppressedByModal = state.modals.length > 0;

    const contextValue: ModalContextValue = {
        isKeyboardLiftSuppressedByModal,
        state,
        showModal,
        hideModal,
        hideAllModals,
        updateCustomModalProps,
    };

    return (
        <OverlayPortalProvider>
            <ModalContext.Provider value={contextValue}>
                {children}
                <OverlayPortalHost zIndex={screenOverlayPortalZIndex} />
                {state.modals.map((modal, index) => {
                    const showBackdrop = index === topVisibleIndex;
                    const modalZIndexBase = zIndexBase + index * zIndexStep;

                    if (modal.type === 'alert') {
                        return (
                            <WebAlertModal
                                key={modal.id}
                                config={modal}
                                onClose={() => dismissModal(modal)}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    if (modal.type === 'confirm') {
                        return (
                            <WebAlertModal
                                key={modal.id}
                                config={modal}
                                onClose={() => dismissModal(modal)}
                                onConfirm={(value) => {
                                    Modal.resolveConfirm(modal.id, value);
                                    hideModal(modal.id);
                                }}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    if (modal.type === 'prompt') {
                        return (
                            <WebPromptModal
                                key={modal.id}
                                config={modal}
                                onClose={() => dismissModal(modal)}
                                onConfirm={(value) => {
                                    Modal.resolvePrompt(modal.id, value);
                                    hideModal(modal.id);
                                }}
                                showBackdrop={showBackdrop}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    if (modal.type === 'custom') {
                        return (
                            <CustomModal
                                key={modal.id}
                                config={modal}
                                onClose={() => dismissModal(modal)}
                                showBackdrop={showBackdrop}
                                visible={modal.visible}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    return null;
                })}
            </ModalContext.Provider>
        </OverlayPortalProvider>
    );
}
