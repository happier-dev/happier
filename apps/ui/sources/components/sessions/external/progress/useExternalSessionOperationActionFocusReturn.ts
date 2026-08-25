import * as React from 'react';

import {
    restoreFocusToBestTarget,
    useFocusReturnFallbackRef,
    type FocusReturnTarget,
} from '@/keyboard/focusReturn';

/**
 * Keeps keyboard and screen-reader focus inside an External Session operation
 * card when the control a reader activated is replaced by its own result.
 *
 * These cards render the operation's currently available actions, so a committed
 * action can rewrite that set: Resume disappears once it is running, Check Again
 * disappears once the read succeeds. The activated control then unmounts under
 * the reader and focus falls to the document root, losing their place in the
 * transcript. This returns focus to a control that survived, through the shared
 * focus-return owner, and does nothing while the activated control is still
 * there — pulling focus off a control the reader is still on would be its own
 * regression. When the card itself is retired there is no successor to move to
 * and the shared fallback owns where focus lands.
 */
export function useExternalSessionOperationActionFocusReturn<TKind extends string>(params: Readonly<{
    availableActionKinds: readonly TKind[];
    /** False while the activated action is still running, so its own result can still change the set. */
    settled?: boolean;
}>) {
    const { availableActionKinds } = params;
    const settled = params.settled !== false;
    const pendingKindRef = React.useRef<TKind | null>(null);
    const nodesRef = React.useRef(new Map<TKind, FocusReturnTarget>());
    const nodeCallbacksRef = React.useRef(new Map<TKind, (node: FocusReturnTarget) => void>());
    const fallbackRef = useFocusReturnFallbackRef<FocusReturnTarget>();

    // A stable callback per action keeps its host node attached across the
    // re-renders every operation revision causes.
    const actionNodeRef = React.useCallback((kind: TKind) => {
        const cached = nodeCallbacksRef.current.get(kind);
        if (cached) return cached;
        const callback = (node: FocusReturnTarget) => {
            if (node === null || node === undefined) {
                nodesRef.current.delete(kind);
                return;
            }
            nodesRef.current.set(kind, node);
        };
        nodeCallbacksRef.current.set(kind, callback);
        return callback;
    }, []);

    const armActionFocusReturn = React.useCallback((kind: TKind) => {
        pendingKindRef.current = kind;
    }, []);

    // Runs after every commit because the replacement action set arrives as an
    // ordinary operation revision, not as an event a card can await.
    React.useEffect(() => {
        const kind = pendingKindRef.current;
        if (kind === null || !settled) return;
        if (availableActionKinds.includes(kind)) return;
        pendingKindRef.current = null;
        const successor = availableActionKinds
            .map((candidate) => nodesRef.current.get(candidate))
            .find((node) => node !== undefined) ?? null;
        restoreFocusToBestTarget({ current: successor }, fallbackRef);
    });

    return { actionNodeRef, armActionFocusReturn } as const;
}
