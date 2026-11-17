import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { ModalConfig, type ModalShowConfig, ModalContextValue, ModalType, type CustomModalConfig } from './types';
import { Modal } from './ModalManager';
import { WebAlertModal } from './components/WebAlertModal';
import { WebPromptModal } from './components/WebPromptModal';
import { CustomModal } from './components/CustomModal';
import { resolveCustomModalPresentation } from './components/customModalChrome';
import { useDeviceType } from '@/utils/platform/responsive';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { readDocumentFocusReturnTarget } from '@/keyboard/focusReturn';
import { MODAL_Z_INDEX, MODAL_Z_INDEX_STEP, SCREEN_OVERLAY_Z_INDEX } from '@/components/ui/overlays/overlayLayers';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { ModalContentIdProvider, useModalContentId } from './context/ModalContentIdContext';

const ModalContext = createContext<ModalContextValue | undefined>(undefined);
// Consumers that only need presentation context must not receive titles,
// prompts, callbacks, or custom modal props from the modal host state.
const VisibleModalKindContext = createContext<ModalType | null>(null);
const VisibleModalIdContext = createContext<string | null>(null);

type VisibleModal = Readonly<{ kind: ModalType; id: string }>;
/**
 * A modally presented route (Settings, `/new`) hosts its own provider inside the app's root one. The
 * dialog in front may live in that nested host, while its readers (the current-UI context) sit above it,
 * so each host reports its front dialog to its parent. A host's own dialog renders above everything in
 * its children, so it wins over a nested report.
 */
const NestedVisibleModalReportContext = createContext<((host: object, visible: VisibleModal | null) => void) | null>(null);

/** Host-owned identities let contextual controls distinguish the foreground dialog from retained content. */
export const useVisibleModalId = () => useContext(VisibleModalIdContext);
export { useModalContentId };

type ModalProviderProps = Readonly<{
    active?: boolean;
    /** Optional: a bare host (no wrapped tree) presents dialogs opened through the global `Modal` API. */
    children?: React.ReactNode;
}>;

type ModalHostEntry = ModalConfig & Readonly<{
    visible: boolean;
    /** The dialog a card hung from a control belongs to: it closes with that dialog. */
    hostId?: string;
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

/** Returns only the top visible dialog kind; modal content remains host-private. */
export function useVisibleModalKind(): ModalType | null {
    return useContext(VisibleModalKindContext);
}

function HostedCustomModal({ config, hideModal, ...props }: Omit<React.ComponentProps<typeof CustomModal>, 'onClose'> & Readonly<{
    hideModal: (id: string) => void;
}>) {
    // Updating a dependent picker must not change its parent's injected close callback.
    // Otherwise the parent content rerenders and can publish fresh picker props back to this host.
    const onClose = useCallback(() => hideModal(config.id), [config.id, hideModal]);
    return <CustomModal {...props} config={config} onClose={onClose} />;
}

export function ModalProvider({ active = true, children }: ModalProviderProps) {
    const [state, setState] = useState<ModalHostState>({
        modals: []
    });
    const stateRef = React.useRef<ModalHostState>(state);
    const reportToParent = useContext(NestedVisibleModalReportContext);
    const [hostKey] = useState(() => ({}));
    const [nestedReports, setNestedReports] = useState<ReadonlyMap<object, VisibleModal>>(() => new Map());
    const reportNested = useCallback((host: object, visible: VisibleModal | null) => setNestedReports(previous => {
        const current = previous.get(host);
        if (current?.id === visible?.id && current?.kind === visible?.kind) return previous;
        const next = new Map(previous);
        if (visible) next.set(host, visible);
        else next.delete(host);
        return next;
    }), []);
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

    const showModal = useCallback((config: ModalShowConfig): string => {
        const id = generateId();
        // Child autofocus runs before the modal shell's layout effect. Capture the
        // opener before mounting, then let the existing modal focus owner restore it.
        // A menu item may disappear as it opens a card. Its persistent view anchor
        // owns the return target on both anchored desktop cards and phone sheets.
        const chrome = config.type === 'custom' ? (config as Omit<CustomModalConfig, 'id'>).chrome : undefined;
        const anchor = chrome?.kind === 'card' ? chrome.anchor : undefined;
        const focusReturnRef = config.focusReturnRef ?? (anchor?.kind === 'view' ? anchor.ref : undefined) ?? (
            Platform.OS === 'web' && typeof document !== 'undefined'
                ? { current: readDocumentFocusReturnTarget(document) }
                : undefined
        );
        // A card hung from a control belongs to the dialog that control sits in (the topmost open one).
        const hostId = anchor ? [...stateRef.current.modals].reverse().find(modal => modal.visible)?.id : undefined;
        const modalConfig = { ...config, focusReturnRef, id, visible: true, ...(hostId ? { hostId } : {}) } as ModalHostEntry;
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

    const hideModal = useCallback(function hide(id: string) {
        const target = stateRef.current.modals.find(modal => modal.id === id);
        const hungCards = stateRef.current.modals.filter(modal => modal.visible && modal.hostId === id);
        // Every dialog kind leaves through the same exit as a custom modal; the host removes it once that has played.
        const shouldDelayRemoval = target?.visible === true;

        setState(prev => {
            const currentTarget = prev.modals.find(modal => modal.id === id);
            if (!currentTarget) return prev;
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

        // Cards hung from controls in this dialog leave with it; their openers hear a dismissal.
        for (const card of hungCards) {
            try {
                if (card.type === 'custom') card.onRequestClose?.();
            } catch {
                // One card's observer must not keep the others open.
            }
            hide(card.id);
        }

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

        const unregisterProvider = Modal.registerProvider({
            showModal,
            hideModal,
            hideAllModals,
            updateCustomModalProps,
        });
        return () => {
            // Restore the previous host before settling this host's work so a
            // continuation can re-present through the canonical provider stack.
            unregisterProvider();
            const ownedModals = stateRef.current.modals;
            const nextState = { modals: [] };
            stateRef.current = nextState;
            setState(nextState);
            for (const modal of ownedModals) {
                try {
                    if (modal.type === 'alert') {
                        Modal.resolveAlert(modal.id);
                    } else if (modal.type === 'confirm') {
                        Modal.resolveConfirm(modal.id, false);
                    } else if (modal.type === 'prompt') {
                        Modal.resolvePrompt(modal.id, null);
                    } else {
                        modal.onHostUnmount?.();
                    }
                } catch {
                    // One modal owner must not strand the remaining host-owned work.
                }
            }
        };
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
        // Derived here rather than at each consumer so "a modal owns the keyboard" has one owner. Only a modal that
        // is showing owns it: one that is leaving stays in the stack for its exit (seconds on a busy JS thread), and
        // a composer focused meanwhile (Bots → New bot) sat behind the keyboard until it was removed.
        isKeyboardLiftSuppressedByModal: state.modals.some((modal) => modal.visible),
        state,
        showModal,
        hideModal,
        hideAllModals,
        updateCustomModalProps,
    };

    const topVisibleIndex = state.modals.reduce((topIndex, modal, index) => (
        modal.visible ? index : topIndex
    ), -1);
    // A card hung from a control (an anchored popover) draws no scrim of its own, so the scrim stays with the
    // topmost visible modal that draws one: a dialog keeps dimming the page while its Add key card is open.
    const deviceType = useDeviceType();
    const topScrimIndex = state.modals.reduce((scrimIndex, modal, index) => (
        modal.visible && !(modal.type === 'custom' && resolveCustomModalPresentation(modal.chrome, deviceType).anchor) ? index : scrimIndex
    ), -1);
    const ownVisible = topVisibleIndex >= 0 ? state.modals[topVisibleIndex]! : null;
    const nestedVisible = nestedReports.size > 0 ? [...nestedReports.values()].at(-1)! : null;
    const visibleModalKind = ownVisible?.type ?? nestedVisible?.kind ?? null;
    const visibleModalId = ownVisible?.id ?? nestedVisible?.id ?? null;
    // An inactive (unfocused) route host keeps its dialogs but is not in front.
    useEffect(() => {
        if (!reportToParent) return;
        reportToParent(hostKey, active && visibleModalKind && visibleModalId ? { kind: visibleModalKind, id: visibleModalId } : null);
    }, [active, hostKey, reportToParent, visibleModalId, visibleModalKind]);
    useEffect(() => () => reportToParent?.(hostKey, null), [hostKey, reportToParent]);
    const zIndexStep = MODAL_Z_INDEX_STEP;
    const zIndexBase = MODAL_Z_INDEX;
    const screenOverlayPortalZIndex = SCREEN_OVERLAY_Z_INDEX;

    return (
        <OverlayPortalProvider>
            <VisibleModalKindContext.Provider value={visibleModalKind}>
            <VisibleModalIdContext.Provider value={visibleModalId}>
            <NestedVisibleModalReportContext.Provider value={reportNested}>
                <ModalContext.Provider value={contextValue}>
                    {children}
                    <OverlayPortalHost zIndex={screenOverlayPortalZIndex} />
                    {state.modals.map((modal, index) => {
                    // A topmost modal that is leaving keeps its scrim, which fades with it, instead of dropping it at once.
                    const showBackdrop = index === topScrimIndex || (!modal.visible && index === state.modals.length - 1);
                    const modalZIndexBase = zIndexBase + index * zIndexStep;

                    const renderModal = () => {
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
                                    visible={modal.visible}
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
                                    visible={modal.visible}
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
                                    visible={modal.visible}
                                    zIndexBase={modalZIndexBase}
                                />
                            );
                        }

                        if (modal.type === 'custom') {
                            return (
                                <PluginSurfaceFocusEligibilityProvider
                                    active={active && modal.visible && index === topVisibleIndex}
                                    presentationActive={active && modal.visible}
                                    currentUiContextActive={active && modal.visible && index === topVisibleIndex}
                                >
                                <HostedCustomModal
                                    key={modal.id}
                                    config={modal}
                                    hideModal={hideModal}
                                    showBackdrop={showBackdrop}
                                    visible={modal.visible}
                                    zIndexBase={modalZIndexBase}
                                />
                                </PluginSurfaceFocusEligibilityProvider>
                            );
                        }

                        return null;
                    };
                    return <ModalContentIdProvider key={modal.id} id={modal.id}>
                        {renderModal()}
                    </ModalContentIdProvider>;
                    })}
                </ModalContext.Provider>
            </NestedVisibleModalReportContext.Provider>
            </VisibleModalIdContext.Provider>
            </VisibleModalKindContext.Provider>
        </OverlayPortalProvider>
    );
}
