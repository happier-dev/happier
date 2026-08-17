import * as React from 'react';
import { Animated, Platform, View, type ViewProps } from 'react-native';

import { usePaneAnimatedPresence } from './motion/usePaneAnimatedPresence';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { NativeBackLayerBoundary } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { useWebOverlayFocusContainment } from '@/keyboard/webOverlayFocusContainment';
import {
    focusNativeAccessibilityTarget,
    restoreFocusToBestTarget,
    type FocusReturnMutableRef,
    type FocusReturnTarget,
} from '@/keyboard/focusReturn';

type NativeAccessibilityFocusAnchor = Readonly<{
    ref: React.RefCallback<unknown>;
    label: string;
}>;

type ModalPaneBoundaryViewProps = ViewProps & Pick<
    React.HTMLAttributes<HTMLElement>,
    'aria-hidden' | 'aria-label' | 'aria-modal' | 'inert' | 'role' | 'tabIndex'
> & Readonly<{
    /** Keeps pane boundaries in a retained modal underlay from competing with the visible overlay. */
    suppressDescendantPaneBoundaries?: boolean;
    /** Internal handoff to the single native-Back boundary surrounding this pane. */
    nativeBackLayer?: Readonly<{
        active: boolean;
        onRequestClose: () => void;
    }>;
    /** Native-only leaf used to establish screen-reader focus without grouping pane controls. */
    nativeAccessibilityFocusAnchor?: NativeAccessibilityFocusAnchor;
}>;

const PaneBoundarySuppressionContext = React.createContext(false);

/**
 * React Native Web's DOM-only modal attributes have one typed, local bridge.
 * Every retained pane boundary uses this bridge rather than re-declaring it.
 */
export const ModalPaneBoundaryView = React.forwardRef<unknown, ModalPaneBoundaryViewProps>(
    function ModalPaneBoundaryView(props, ref) {
        const inheritedSuppression = React.useContext(PaneBoundarySuppressionContext);
        const {
            suppressDescendantPaneBoundaries = false,
            nativeBackLayer,
            nativeAccessibilityFocusAnchor,
            children,
            ...viewProps
        } = props;
        const suppressDescendants = inheritedSuppression || suppressDescendantPaneBoundaries;
        const view = (
            <View
                ref={ref as React.Ref<React.ElementRef<typeof View>>}
                {...viewProps}
                // Pane underlay refs are the native fallback after a close, so
                // retain this otherwise-layout-only host in the native tree.
                collapsable={Platform.OS === 'web' ? viewProps.collapsable : false}
            >
                {Platform.OS !== 'web' && nativeAccessibilityFocusAnchor ? (
                    <View
                        ref={nativeAccessibilityFocusAnchor.ref as React.Ref<React.ElementRef<typeof View>>}
                        accessible
                        accessibilityLabel={nativeAccessibilityFocusAnchor.label}
                        collapsable={false}
                        style={nativeAccessibilityFocusAnchorStyle}
                    />
                ) : null}
                {children}
            </View>
        );

        return (
            <PaneBoundarySuppressionContext.Provider value={suppressDescendants}>
                <NativeBackLayerBoundary
                    active={nativeBackLayer?.active === true}
                    onRequestClose={nativeBackLayer?.onRequestClose}
                    suppressDescendants={suppressDescendants}
                >
                    {view}
                </NativeBackLayerBoundary>
            </PaneBoundarySuppressionContext.Provider>
        );
    },
);

export type ModalPaneBoundaryOptions = Readonly<{
    /** True while this pane is visually presented above an inert retained underlay. */
    active: boolean;
    label: string;
    onRequestClose: () => void;
    focusReturnRef?: FocusReturnMutableRef;
    /** Clears a capture made while the pane was docked before it turns into an overlay. */
    discardPendingFocusReturn?: boolean;
    /** Docked panes retain their lower Escape priority; modal panes use overlay priority. */
    escapeEnabled?: boolean;
    escapePriority?: number;
    /**
     * A modal pane remains dismissible from an editable control after its
     * higher-priority child menus decline Escape. Docked panes retain their
     * established text-editing Escape behavior.
     */
    allowEditableEscape?: boolean;
}>;

export type ModalPaneBoundary = Readonly<{
    setUnderlayFocusRef: React.RefCallback<unknown>;
    setOverlayFocusRef: React.RefCallback<unknown>;
    underlayProps: Readonly<{
        tabIndex?: -1;
        pointerEvents: 'auto' | 'none';
        inert?: true;
        'aria-hidden'?: true;
        accessibilityElementsHidden?: boolean;
        importantForAccessibility?: 'auto' | 'no-hide-descendants';
        suppressDescendantPaneBoundaries: boolean;
    }>;
    overlayProps: Readonly<{
        tabIndex?: -1;
        role?: 'dialog';
        'aria-modal'?: true;
        'aria-label'?: string;
        accessibilityLabel?: string;
        accessibilityViewIsModal?: true;
        nativeBackLayer?: Readonly<{
            active: true;
            onRequestClose: () => void;
        }>;
        nativeAccessibilityFocusAnchor?: NativeAccessibilityFocusAnchor;
    }>;
}>;

const nativeAccessibilityFocusAnchorStyle = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    pointerEvents: 'none' as const,
};

/**
 * The one semantic/focus/escape boundary for retained pane overlays. Its View
 * bridge owns native Back so descendant overlays retain platform topmost
 * ordering without adding a router or focus manager.
 */
export function useModalPaneBoundary(options: ModalPaneBoundaryOptions): ModalPaneBoundary {
    const isWeb = Platform.OS === 'web';
    const suppressedByRetainedAncestor = React.useContext(PaneBoundarySuppressionContext);
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    const underlayFocusRef = React.useRef<unknown>(null);
    const nativeOverlayFocusRef = React.useRef<unknown>(null);
    const underlayWebFocusRef = React.useRef<HTMLElement | null>(null);
    const overlayWebFocusRef = React.useRef<HTMLElement | null>(null);
    const localOpeningFocusReturnRef = React.useRef<FocusReturnTarget>(null);
    const focusReturnRef = options.focusReturnRef ?? localOpeningFocusReturnRef;
    const focusReturnRefRef = React.useRef(focusReturnRef);
    focusReturnRefRef.current = focusReturnRef;
    const nativeReturnFocusRef = React.useRef<FocusReturnMutableRef | null>(null);
    const nativeReturnFocusTargetRef = React.useRef<FocusReturnTarget>(null);
    const suppressedByRetainedAncestorRef = React.useRef(suppressedByRetainedAncestor);
    suppressedByRetainedAncestorRef.current = suppressedByRetainedAncestor;

    const setUnderlayFocusRef = React.useCallback<React.RefCallback<unknown>>((node) => {
        underlayFocusRef.current = node;
        underlayWebFocusRef.current = resolveWebFocusableElement(node, isWeb);
    }, [isWeb]);
    const setOverlayFocusRef = React.useCallback<React.RefCallback<unknown>>((node) => {
        overlayWebFocusRef.current = resolveWebFocusableElement(node, isWeb);
    }, [isWeb]);
    const setNativeOverlayFocusRef = React.useCallback<React.RefCallback<unknown>>((node) => {
        nativeOverlayFocusRef.current = node;
    }, []);

    useWebOverlayFocusContainment({
        active: isWeb && options.active && !suppressedByRetainedAncestor,
        containerRef: overlayWebFocusRef,
        fallbackRef: underlayWebFocusRef,
        focusReturn: {
            kind: 'pre-mutation',
            ref: focusReturnRef,
            discardPendingCapture: options.discardPendingFocusReturn === true,
        },
    });

    React.useLayoutEffect(() => {
        if (isWeb || options.discardPendingFocusReturn !== true) return;
        focusReturnRefRef.current.current = null;
    }, [isWeb, options.discardPendingFocusReturn]);

    React.useLayoutEffect(() => {
        if (isWeb || !options.active || suppressedByRetainedAncestor) return;

        const returnFocusRef = focusReturnRefRef.current;
        nativeReturnFocusRef.current = returnFocusRef;
        nativeReturnFocusTargetRef.current = returnFocusRef.current;
        focusNativeAccessibilityTarget(nativeOverlayFocusRef.current as FocusReturnTarget);

        return () => {
            if (nativeReturnFocusRef.current !== returnFocusRef) return;
            nativeReturnFocusRef.current = null;
            const returnFocusTarget = nativeReturnFocusTargetRef.current;
            nativeReturnFocusTargetRef.current = null;
            if (!suppressedByRetainedAncestorRef.current) {
                restoreFocusToBestTarget(
                    { current: returnFocusTarget },
                    { current: underlayFocusRef.current as FocusReturnTarget },
                );
            }
            returnFocusRef.current = null;
        };
    }, [isWeb, options.active, suppressedByRetainedAncestor]);

    useEscapeLayer({
        // Web Escape is stack-owned; Android Back remains the platform-native
        // dismissal owner below. Native keyboard handling keeps flowing through
        // the existing input/key-command owners.
        enabled: isWeb && options.escapeEnabled === true && !suppressedByRetainedAncestor,
        priority: options.escapePriority ?? ESCAPE_LAYER_PRIORITIES.overlay,
        // A child composer/menu gets first refusal through its higher layer;
        // once it releases Escape, an active modal pane must still be closable
        // from an editable control. Docked panes intentionally keep their
        // incumbent editing behavior.
        allowEditableTarget: options.allowEditableEscape === true,
        onEscape: () => {
            optionsRef.current.onRequestClose();
            return true;
        },
    });

    const underlayProps = React.useMemo<ModalPaneBoundary['underlayProps']>(() => ({
        tabIndex: isWeb ? -1 : undefined,
        pointerEvents: options.active ? 'none' as const : 'auto' as const,
        inert: isWeb && options.active ? true : undefined,
        'aria-hidden': isWeb && options.active ? true : undefined,
        accessibilityElementsHidden: isWeb ? undefined : options.active,
        importantForAccessibility: isWeb
            ? undefined
            : options.active ? 'no-hide-descendants' as const : 'auto' as const,
        suppressDescendantPaneBoundaries: options.active,
    }), [isWeb, options.active]);

    const overlayProps = React.useMemo<ModalPaneBoundary['overlayProps']>(() => ({
        tabIndex: isWeb ? -1 : undefined,
        role: isWeb && options.active ? 'dialog' as const : undefined,
        'aria-modal': isWeb && options.active ? true : undefined,
        'aria-label': isWeb && options.active ? options.label : undefined,
        accessibilityLabel: options.active ? options.label : undefined,
        accessibilityViewIsModal: !isWeb && options.active ? true : undefined,
        nativeBackLayer: options.active && !suppressedByRetainedAncestor
            ? { active: true, onRequestClose: options.onRequestClose }
            : undefined,
        nativeAccessibilityFocusAnchor: !isWeb && options.active && !suppressedByRetainedAncestor
            ? { ref: setNativeOverlayFocusRef, label: options.label }
            : undefined,
    }), [
        isWeb,
        options.active,
        options.label,
        options.onRequestClose,
        setNativeOverlayFocusRef,
        suppressedByRetainedAncestor,
    ]);

    return {
        setUnderlayFocusRef,
        setOverlayFocusRef,
        underlayProps,
        overlayProps,
    };
}

function resolveWebFocusableElement(node: unknown, isWeb: boolean): HTMLElement | null {
    if (!isWeb || typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) {
        return null;
    }
    return node;
}

export type ModalPanePresentationInput = Readonly<{
    targetOpen: boolean;
    node: React.ReactNode | null;
    overlay: boolean;
    onClose: () => void;
}>;

/**
 * One cancellation-aware close lifecycle for right/details/bottom panes.
 * The retained-presence owner runs the animation; this hook delays the state
 * close until that transition settles and bypasses it for reduced motion.
 */
export function useModalPanePresentation(input: ModalPanePresentationInput): Readonly<{
    present: boolean;
    node: React.ReactNode | null;
    progress: Animated.Value;
    durationMs: number;
    useNativeDriver: boolean;
    closing: boolean;
    requestClose: () => void;
}> {
    const reduceMotion = useReducedMotionPreference();
    const durationMs = reduceMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.base;
    // Pane progress also drives docked width/height interpolation, which needs
    // the JS driver on both native and web.
    const useNativeDriver = false;
    const [closing, setClosing] = React.useState(false);
    const closeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeInFlightRef = React.useRef(false);

    const effectiveTargetOpen = input.targetOpen && !(input.overlay && closing);
    const presence = usePaneAnimatedPresence({
        targetOpen: effectiveTargetOpen,
        node: input.node,
        durationMs,
        useNativeDriver,
    });

    const clearPendingClose = React.useCallback(() => {
        if (closeTimeoutRef.current) {
            clearTimeout(closeTimeoutRef.current);
            closeTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        if (input.targetOpen) return;
        clearPendingClose();
        closeInFlightRef.current = false;
        setClosing(false);
    }, [clearPendingClose, input.targetOpen]);

    React.useEffect(() => () => clearPendingClose(), [clearPendingClose]);

    const requestClose = React.useCallback(() => {
        if (!input.overlay || !presence.present || reduceMotion) {
            input.onClose();
            return;
        }
        if (closeInFlightRef.current) return;

        closeInFlightRef.current = true;
        setClosing(true);
        clearPendingClose();
        closeTimeoutRef.current = setTimeout(() => {
            closeTimeoutRef.current = null;
            input.onClose();
        }, durationMs);
    }, [clearPendingClose, durationMs, input, presence.present, reduceMotion]);

    return {
        ...presence,
        durationMs,
        useNativeDriver,
        closing,
        requestClose,
    };
}
