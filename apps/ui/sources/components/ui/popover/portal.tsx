import * as React from 'react';
import { Platform } from 'react-native';

import { requireReactDOM } from '@/utils/web/reactDomCjs';

type OverlayPortalDispatch = Readonly<{
    setPortalNode: (id: string, node: React.ReactNode) => void;
    removePortalNode: (id: string) => void;
}>;

type PortalContentStore = Readonly<{
    getSnapshot: () => React.ReactNode;
    setContent: (node: React.ReactNode) => void;
    subscribe: (listener: () => void) => () => void;
}>;

function createPortalContentStore(): PortalContentStore {
    let current: React.ReactNode = null;
    const listeners = new Set<() => void>();

    return {
        getSnapshot: () => current,
        setContent: (node: React.ReactNode) => {
            if (Object.is(current, node)) return;
            current = node;
            for (const listener of listeners) listener();
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/**
 * The single element the overlay-portal host holds for one popover. Its identity is created once
 * per `Popover` instance, so a popover re-render never rewrites the host's node map.
 */
function OverlayPortalContent(props: Readonly<{ store: PortalContentStore }>) {
    const node = React.useSyncExternalStore(
        props.store.subscribe,
        props.store.getSnapshot,
        props.store.getSnapshot,
    );
    return <>{node}</>;
}

/**
 * Native has no true React portal, so overlay content reaches the host through provider state.
 *
 * The registered node must therefore be REFERENTIALLY STABLE. `Popover` builds a fresh `content`
 * element on every render; registering that element directly made this effect tear down and
 * re-register on every render, and each `setPortalNode`/`removePortalNode` clones the host's node
 * map and publishes a new context value — so one popover render re-rendered the host and every
 * other portaled overlay with it, twice.
 *
 * Instead we register a stable element once per popover and push content through a per-popover
 * store. New content then re-renders exactly one leaf (`OverlayPortalContent`) and leaves the host
 * map, the context value, and sibling overlays untouched.
 */
export function useNativeOverlayPortalNode(params: Readonly<{
    overlayPortal: OverlayPortalDispatch | null;
    portalId: string;
    enabled: boolean;
    content: React.ReactNode | null;
}>) {
    const { overlayPortal, portalId, enabled, content } = params;

    const storeRef = React.useRef<PortalContentStore | null>(null);
    if (storeRef.current === null) {
        storeRef.current = createPortalContentStore();
    }
    const store = storeRef.current;

    const stableNodeRef = React.useRef<React.ReactNode>(null);
    if (stableNodeRef.current === null) {
        stableNodeRef.current = <OverlayPortalContent store={store} />;
    }

    const active = Boolean(enabled && content);

    // Declared first so the host's very first render of the stable node already sees real content.
    React.useLayoutEffect(() => {
        store.setContent(content);
    }, [content, store]);

    React.useLayoutEffect(() => {
        if (!overlayPortal) return;
        if (!active) {
            overlayPortal.removePortalNode(portalId);
            return;
        }
        overlayPortal.setPortalNode(portalId, stableNodeRef.current);
        return () => {
            overlayPortal.removePortalNode(portalId);
        };
    }, [active, overlayPortal, portalId]);
}

export function tryRenderWebPortal(params: Readonly<{
    shouldPortalWeb: boolean;
    portalTargetOnWeb: 'body' | 'boundary' | 'modal';
    modalPortalTarget: HTMLElement | null;
    getBoundaryDomElement: () => HTMLElement | null;
    content: React.ReactNode;
}>): React.ReactNode | null {
    if (!params.shouldPortalWeb) return null;
    if (Platform.OS !== 'web') return null;

    try {
        const ReactDOM = requireReactDOM();
        const boundaryEl = params.getBoundaryDomElement();
        const targetRequested =
            params.portalTargetOnWeb === 'modal'
                ? params.modalPortalTarget
                : params.portalTargetOnWeb === 'boundary'
                    ? boundaryEl
                    : (typeof document !== 'undefined' ? document.body : null);

        const target =
            targetRequested
            ?? (params.portalTargetOnWeb === 'body' && typeof document !== 'undefined'
                ? document.body
                : null);
        if (target && ReactDOM?.createPortal) {
            return ReactDOM.createPortal(params.content, target);
        }
    } catch {
        // fall back to inline render
    }

    return null;
}
