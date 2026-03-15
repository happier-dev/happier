import * as React from 'react';
import { Platform } from 'react-native';

/**
 * On web, some overlay/modal implementations install document-level wheel/touchmove scroll-lock
 * listeners. If those listeners run on the bubble phase, stopping propagation at a subtree root
 * (via native DOM listeners) keeps wheel/touch scroll working inside scrollable panes.
 *
 * Note: This is best-effort. If a scroll-lock listener is installed in the capture phase and
 * calls preventDefault(), no subtree-level propagation stop can override it.
 */
export function useWebScrollLockBypass(params: Readonly<{
    enabled?: boolean;
    rootRef: React.RefObject<any>;
}>) {
    const enabled = params.enabled ?? true;

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!enabled) return;

        const raw = params.rootRef.current as any;
        const el = (raw?.getScrollableNode?.() ?? raw) as HTMLElement | null;
        if (!el || typeof (el as any).addEventListener !== 'function') return;

        const stopPropagation = (event: any) => {
            try {
                event?.stopPropagation?.();
            } catch {
                // ignore
            }
        };

        // Always install bubble-phase listeners so native scrolling still occurs on the target element.
        //
        // Rationale: scroll-lock implementations vary widely across web stacks; relying on heuristics
        // (e.g. `overflow: hidden`) can miss some cases and leave nested panes non-scrollable. This
        // is best-effort: capture-phase preventDefault() handlers cannot be overridden here.
        el.addEventListener('wheel', stopPropagation, { passive: true });
        el.addEventListener('touchmove', stopPropagation, { passive: true });
        return () => {
            el.removeEventListener('wheel', stopPropagation as any);
            el.removeEventListener('touchmove', stopPropagation as any);
        };
    }, [enabled, params.rootRef]);
}
