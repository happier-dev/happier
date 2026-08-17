import {
    readDocumentFocusReturnTarget,
    type FocusReturnMutableRef,
    type FocusReturnTarget,
} from '@/keyboard/focusReturn';

export type PaneOverlayFocusSurface = 'bottom' | 'details' | 'right';

export type PaneOverlayFocusReturnOwner = Readonly<{
    capture: (scopeId: string, surface: PaneOverlayFocusSurface) => void;
    /** Records the native control that originated the next pane command. */
    recordNativeFocusTarget: (scopeId: string, target: unknown) => void;
    clear: (scopeId: string, surface: PaneOverlayFocusSurface) => void;
    clearAll: () => void;
    getRef: (scopeId: string, surface: PaneOverlayFocusSurface) => FocusReturnMutableRef;
}>;

type PaneOverlayFocusRefs = Record<PaneOverlayFocusSurface, FocusReturnMutableRef> & Readonly<{
    nativeCommandTarget: FocusReturnMutableRef;
}>;

/**
 * AppPane-local, non-persistent focus handoffs for overlays whose opening
 * command will make their retained underlay inert. The command owner captures
 * synchronously; visual consumers only take the matching pending ref.
 */
export function createPaneOverlayFocusReturnOwner(): PaneOverlayFocusReturnOwner {
    const refsByScopeId = new Map<string, PaneOverlayFocusRefs>();

    const getRefs = (scopeId: string): PaneOverlayFocusRefs => {
        let refs = refsByScopeId.get(scopeId);
        if (!refs) {
            refs = {
                bottom: { current: null },
                details: { current: null },
                right: { current: null },
                nativeCommandTarget: { current: null },
            };
            refsByScopeId.set(scopeId, refs);
        }
        return refs;
    };

    const getRef = (scopeId: string, surface: PaneOverlayFocusSurface): FocusReturnMutableRef => {
        return getRefs(scopeId)[surface];
    };

    return {
        capture: (scopeId, surface) => {
            const ref = getRef(scopeId, surface);
            ref.current = typeof document === 'undefined'
                ? getRefs(scopeId).nativeCommandTarget.current
                : readDocumentFocusReturnTarget(document);
        },
        recordNativeFocusTarget: (scopeId, target) => {
            getRefs(scopeId).nativeCommandTarget.current = typeof target === 'number'
                && Number.isInteger(target)
                && target > 0
                ? target
                : null;
        },
        clear: (scopeId, surface) => {
            getRef(scopeId, surface).current = null;
        },
        clearAll: () => {
            for (const refs of refsByScopeId.values()) {
                refs.bottom.current = null;
                refs.details.current = null;
                refs.right.current = null;
                refs.nativeCommandTarget.current = null;
            }
        },
        getRef,
    };
}
