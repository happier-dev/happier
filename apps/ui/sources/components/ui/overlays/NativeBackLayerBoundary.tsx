import * as React from 'react';
import { BackHandler, Platform } from 'react-native';

type RegisterNativeBackDescendant = () => () => void;

type NativeBackLayerHandler = () => boolean;

type NativeBackLayerContextValue = Readonly<{
    registerDescendant: RegisterNativeBackDescendant;
    /** One guest-history callback belonging to this pane boundary, not a stack. */
    registerBackHandler: (handler: NativeBackLayerHandler) => () => void;
}>;

type NativeBackLayerBoundaryProps = Readonly<{
    active: boolean;
    onRequestClose?: () => void;
    /** Retained underlays must not nominate invisible descendants for Back. */
    suppressDescendants?: boolean;
    children: React.ReactNode;
}>;

// `undefined` means no pane boundary is present; `null` is an intentionally
// suppressed retained underlay. The distinction lets an independently mounted
// native frame yield to the route listener without waking a hidden pane.
const NativeBackLayerContext = React.createContext<NativeBackLayerContextValue | null | undefined>(undefined);

/**
 * Keeps Android Back on React Native's incumbent listener stack while allowing
 * a pane to yield to an already-open descendant overlay. This is deliberately
 * not a router, modal stack, or focus owner: each visible surface still owns
 * its own direct Back handler and close lifecycle.
 */
export function NativeBackLayerBoundary(props: NativeBackLayerBoundaryProps): React.ReactNode {
    const ancestorContext = React.useContext(NativeBackLayerContext);
    const active = props.active && props.onRequestClose != null && !props.suppressDescendants;
    const onRequestCloseRef = React.useRef(props.onRequestClose);
    onRequestCloseRef.current = props.onRequestClose;
    const descendantCountRef = React.useRef(0);
    const descendantBackHandlerRef = React.useRef<NativeBackLayerHandler | null>(null);

    const registerDescendant = React.useCallback<RegisterNativeBackDescendant>(() => {
        descendantCountRef.current += 1;
        let registered = true;
        return () => {
            if (!registered) return;
            registered = false;
            descendantCountRef.current = Math.max(0, descendantCountRef.current - 1);
        };
    }, []);

    const registerBackHandler = React.useCallback((handler: NativeBackLayerHandler) => {
        descendantBackHandlerRef.current = handler;
        let registered = true;
        return () => {
            if (!registered) return;
            registered = false;
            if (descendantBackHandlerRef.current === handler) {
                descendantBackHandlerRef.current = null;
            }
        };
    }, []);
    const activeContextValue = React.useMemo<NativeBackLayerContextValue>(() => ({
        registerDescendant,
        registerBackHandler,
    }), [registerBackHandler, registerDescendant]);

    useNativeBackLayerDescendant(active);

    React.useEffect(() => {
        if (Platform.OS !== 'android' || !active) return;

        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            // React Native dispatches in reverse registration order. A child
            // can predate a docked-to-overlay transition, so this boundary
            // yields rather than incorrectly closing the pane first.
            if (descendantCountRef.current > 0) return false;
            if (descendantBackHandlerRef.current?.() === true) return true;
            onRequestCloseRef.current?.();
            return true;
        });
        return () => subscription.remove();
    }, [active]);

    const contextValue: NativeBackLayerContextValue | null | undefined = props.suppressDescendants
        ? null
        : active
            ? activeContextValue
            : ancestorContext;

    return (
        <NativeBackLayerContext.Provider value={contextValue}>
            {props.children}
        </NativeBackLayerContext.Provider>
    );
}

/**
 * An overlay with its own Android Back listener calls this while open so its
 * active pane ancestor yields to that listener even across a retained-layout
 * transition.
 */
export function useNativeBackLayerDescendant(active: boolean): void {
    const context = React.useContext(NativeBackLayerContext);

    React.useEffect(() => {
        if (!active || !context) return;
        return context.registerDescendant();
    }, [active, context]);
}

/**
 * Adds the one embedded guest-history action to an existing visible pane
 * boundary. Existing descendant overlays keep first refusal; if no pane
 * boundary exists, Android installs one focused listener and otherwise lets
 * the route listener continue.
 */
export function useNativeBackLayerBackHandler(
    active: boolean,
    handler: NativeBackLayerHandler,
): void {
    const context = React.useContext(NativeBackLayerContext);
    const handlerRef = React.useRef(handler);
    handlerRef.current = handler;

    React.useEffect(() => {
        if (!active || !context) return;
        return context.registerBackHandler(() => handlerRef.current());
    }, [active, context]);

    React.useEffect(() => {
        if (Platform.OS !== 'android' || !active || context !== undefined) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => handlerRef.current());
        return () => subscription.remove();
    }, [active, context]);
}
