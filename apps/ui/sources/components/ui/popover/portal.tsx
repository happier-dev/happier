import * as React from 'react';
import { Platform } from 'react-native';

import { requireReactDOM } from '@/utils/web/reactDomCjs';
import { areReactNodesStructurallyEqual } from '@/utils/react/areReactNodesStructurallyEqual';

export const POPOVER_PORTAL_Z_INDEX = 200000;

type OverlayPortalDispatch = Readonly<{
    setPortalNode: (id: string, node: React.ReactNode) => void;
    removePortalNode: (id: string) => void;
}>;

export function useNativeOverlayPortalNode(params: Readonly<{
    overlayPortal: OverlayPortalDispatch | null;
    portalId: string;
    enabled: boolean;
    content: React.ReactNode | null;
}>) {
    const { overlayPortal, portalId, enabled, content } = params;
    const lastContentRef = React.useRef<React.ReactNode | null>(null);

    React.useLayoutEffect(() => {
        if (!overlayPortal) return;
        return () => {
            lastContentRef.current = null;
            overlayPortal.removePortalNode(portalId);
        };
    }, [overlayPortal, portalId]);

    React.useLayoutEffect(() => {
        if (!overlayPortal) return;

        if (!enabled || !content) {
            if (lastContentRef.current !== null) {
                lastContentRef.current = null;
                overlayPortal.removePortalNode(portalId);
            }
            return;
        }

        if (areReactNodesStructurallyEqual(lastContentRef.current, content)) {
            return;
        }

        lastContentRef.current = content;
        overlayPortal.setPortalNode(portalId, content);
    }, [content, enabled, overlayPortal, portalId]);
}

export function tryRenderWebPortal(params: Readonly<{
    shouldPortalWeb: boolean;
    portalTargetOnWeb: 'body' | 'boundary' | 'modal';
    modalPortalTarget: Element | DocumentFragment | null;
    getBoundaryDomElement: () => Element | DocumentFragment | null;
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
