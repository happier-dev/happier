import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ModalConfig, ModalContextValue } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const ModalContext = createContext<ModalContextValue | undefined>(undefined);

type ModalProviderProps = Readonly<{
    active?: boolean;
    children: React.ReactNode;
}>;

type ModalHostEntry = ModalConfig & Readonly<{
    visible: boolean;
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

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    const clearRemovalTimer = useCallback((id: string) => {
        const timer = removalTimersRef.current.get(id);
        if (timer == null) return;
        clearTimeout(timer);
        removalTimersRef.current.delete(id);
    }, []);

    const removeModalNow = useCallback((id: string) => {
        clearRemovalTimer(id);
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
        const modalConfig = { ...config, id, visible: true } as ModalHostEntry;
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

    const contextValue: ModalContextValue = {
        state,
        showModal,
        hideModal,
        hideAllModals,
        updateCustomModalProps,
    };

    const topVisibleIndex = state.modals.reduce((topIndex, modal, index) => (
        modal.visible ? index : topIndex
    ), -1);
    const zIndexStep = 10;
    const zIndexBase = 100000;

    return (
        <OverlayPortalProvider>
            <ModalContext.Provider value={contextValue}>
                {children}
                {state.modals.map((modal, index) => {
                    const showBackdrop = index === topVisibleIndex;
                    const modalZIndexBase = zIndexBase + index * zIndexStep;

                    if (modal.type === 'alert') {
                        return (
                            <WebAlertModal
                                key={modal.id}
                                config={modal}
                                onClose={() => {
                                    Modal.resolveAlert(modal.id);
                                    hideModal(modal.id);
                                }}
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
                                onClose={() => {
                                    Modal.resolveConfirm(modal.id, false);
                                    hideModal(modal.id);
                                }}
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
                                onClose={() => {
                                    Modal.resolvePrompt(modal.id, null);
                                    hideModal(modal.id);
                                }}
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
                                onClose={() => hideModal(modal.id)}
                                showBackdrop={showBackdrop}
                                visible={modal.visible}
                                zIndexBase={modalZIndexBase}
                            />
                        );
                    }

                    return null;
                })}
                <OverlayPortalHost />
            </ModalContext.Provider>
        </OverlayPortalProvider>
    );
}
