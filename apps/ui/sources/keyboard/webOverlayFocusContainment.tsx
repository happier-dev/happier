import * as React from 'react';

import {
    readDocumentFocusReturnTarget,
    restoreFocusToBestTarget,
    useFocusReturnFallbackRef,
    type FocusReturnMutableRef,
    type FocusReturnRef,
    type FocusReturnTarget,
} from './focusReturn';

const WEB_OVERLAY_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export type WebOverlayFocusContainmentOptions = Readonly<{
    active: boolean;
    containerRef: Readonly<{ current: HTMLElement | null }>;
    fallbackRef?: FocusReturnRef;
    /** Makes focus-return authority explicit for each overlay owner. */
    focusReturn: WebOverlayFocusReturnStrategy;
}>;

/**
 * Retained pane overlays must use `pre-mutation` so their command owner
 * supplies focus from before the underlay becomes inert. Portal modals have no
 * retained inert underlay and explicitly retain their incumbent activation-time
 * capture behavior.
 */
export type WebOverlayFocusReturnStrategy =
    | Readonly<{
        kind: 'activation-time';
    }>
    | Readonly<{
        kind: 'provided';
        ref: FocusReturnRef;
    }>
    | Readonly<{
        kind: 'pre-mutation';
        ref: FocusReturnMutableRef;
        /** Clears a capture that opened docked before it can become an overlay. */
        discardPendingCapture: boolean;
    }>;

/**
 * Web-only focus custody for in-layout overlays. Overlay/pane owners retain
 * their own rendering, motion, Escape, and close lifecycle; this hook only
 * keeps keyboard focus within an already-active DOM overlay and returns it on
 * release.
 */
export function useWebOverlayFocusContainment(options: WebOverlayFocusContainmentOptions): void {
    const contextFallbackRef = useFocusReturnFallbackRef<FocusReturnTarget>();
    const returnTargetRef = React.useRef<FocusReturnTarget>(null);
    const fallbackRef = options.fallbackRef ?? contextFallbackRef;
    const preMutationFocusReturnRef = options.focusReturn.kind === 'pre-mutation'
        ? options.focusReturn.ref
        : null;
    const discardPendingCapture = options.focusReturn.kind === 'pre-mutation'
        && options.focusReturn.discardPendingCapture;
    const discardPendingCaptureRef = React.useRef(discardPendingCapture);
    discardPendingCaptureRef.current = discardPendingCapture;

    React.useEffect(() => {
        if (!discardPendingCapture || !preMutationFocusReturnRef) return;
        preMutationFocusReturnRef.current = null;
    }, [discardPendingCapture, preMutationFocusReturnRef]);

    React.useLayoutEffect(() => {
        if (!options.active || typeof document === 'undefined') return;

        const container = options.containerRef.current;
        if (!container || isWithinInertSubtree(container)) return;

        returnTargetRef.current = options.focusReturn.kind === 'activation-time'
            ? readDocumentFocusReturnTarget(document)
            : options.focusReturn.kind === 'provided'
                ? options.focusReturn.ref?.current
                : takePreMutationFocusReturnTarget(preMutationFocusReturnRef);
        // A retained editor can become modal without opening new content. Keep its caret;
        // initial openings from outside the pane still establish focus in the modal shell.
        if (!container.contains(document.activeElement) && !focusElement(container)) {
            focusFirstElement(container);
        }

        return () => {
            const returnTarget = returnTargetRef.current;
            returnTargetRef.current = null;

            // A higher retained overlay can make this shell inert while this
            // lower overlay is being retired. It must not steal focus back
            // from the currently interactive overlay.
            if (isWithinInertSubtree(container)) return;

            const restoreReleasedFocus = () => {
                // Becoming docked releases containment, not the still-open editor's focus.
                // A real close (or an inert hidden pane) still restores its opener/fallback.
                const focused = document.activeElement;
                if (discardPendingCaptureRef.current && focused instanceof HTMLElement
                    && container.contains(focused) && isEligibleFocusTarget(focused)) return;
                const eligibleReturnTarget = isEligibleFocusTarget(returnTarget)
                    ? returnTarget
                    : null;
                const fallbackTarget = isEligibleFocusTarget(fallbackRef?.current)
                    ? fallbackRef.current
                    : null;
                restoreFocusToBestTarget(
                    { current: eligibleReturnTarget },
                    { current: fallbackTarget },
                );
            };
            restoreReleasedFocus();
            // This release runs inside a React commit. When the shell stays in the document (a modal
            // animating out), React then re-focuses the element that held focus before the commit —
            // inside this shell — undoing the release. Re-assert once the commit is done, but only
            // while focus is still in this shell or nowhere, so an overlay that took focus meanwhile keeps it.
            queueMicrotask(() => {
                const focused = document.activeElement;
                if (focused && focused !== document.body && !container.contains(focused)) return;
                if (isWithinInertSubtree(container)) return;
                restoreReleasedFocus();
            });
        };
    }, [
        fallbackRef,
        options.active,
        options.containerRef,
        options.focusReturn.kind,
        preMutationFocusReturnRef,
    ]);

    React.useEffect(() => {
        if (!options.active || typeof document === 'undefined') return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.key !== 'Tab') return;

            const container = options.containerRef.current;
            if (!container || isWithinInertSubtree(container)) return;

            const focusableElements = listFocusableElements(container);
            if (focusableElements.length === 0) {
                event.preventDefault();
                event.stopPropagation();
                focusElement(container);
                return;
            }

            const firstFocusableElement = focusableElements[0]!;
            const lastFocusableElement = focusableElements[focusableElements.length - 1]!;
            const activeElement = document.activeElement;
            const focusIsOutsideOverlay = activeElement == null || !container.contains(activeElement);
            const shouldWrapBackward = event.shiftKey
                && (focusIsOutsideOverlay || activeElement === container || activeElement === firstFocusableElement);
            const shouldWrapForward = !event.shiftKey
                && (focusIsOutsideOverlay || activeElement === container || activeElement === lastFocusableElement);
            if (!shouldWrapBackward && !shouldWrapForward) return;

            event.preventDefault();
            event.stopPropagation();
            focusElement(shouldWrapBackward ? lastFocusableElement : firstFocusableElement);
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [options.active, options.containerRef]);
}

function takePreMutationFocusReturnTarget(ref: FocusReturnMutableRef | null): FocusReturnTarget {
    if (!ref) return null;
    const target = ref.current;
    ref.current = null;
    return target;
}

function focusFirstElement(container: HTMLElement): boolean {
    const firstFocusableElement = listFocusableElements(container)[0] ?? null;
    return firstFocusableElement ? focusElement(firstFocusableElement) : false;
}

function listFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(WEB_OVERLAY_FOCUSABLE_SELECTOR)).filter(
        isEligibleFocusTarget,
    );
}

function isWithinInertSubtree(element: HTMLElement): boolean {
    return element.closest('[inert]') != null;
}

function isEligibleFocusTarget(target: FocusReturnTarget): target is HTMLElement {
    if (!canFocus(target)) return false;
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
    if (target.hidden || target.getAttribute('aria-hidden') === 'true') return false;
    if (target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) return false;
    if (target.closest('[hidden], [aria-hidden="true"], [inert]') != null) return false;

    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(target);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
    }

    return true;
}

function canFocus(target: FocusReturnTarget): target is HTMLElement {
    if (!target || typeof target !== 'object') return false;
    return typeof target.focus === 'function' && target.isConnected !== false;
}

function focusElement(target: FocusReturnTarget): boolean {
    if (!canFocus(target)) return false;
    try {
        target.focus({ preventScroll: true });
        return true;
    } catch {
        try {
            target.focus();
            return true;
        } catch {
            return false;
        }
    }
}
