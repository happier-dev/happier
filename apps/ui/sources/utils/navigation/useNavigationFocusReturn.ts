import * as React from 'react';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/destinationInstanceContext';

import {
    type FocusReturnTarget,
    type NavigationFocusReturnIntent,
    useNavigationFocusReturnIntentRef,
    useRestoreFocusToTrigger,
} from '@/keyboard/focusReturn';

type DomFocusReturnTarget = Readonly<{
    focus: () => void;
    isConnected?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    getAttribute?: (name: string) => string | null;
    getBoundingClientRect?: () => Readonly<{ width: number; height: number }>;
    getClientRects?: () => ArrayLike<unknown>;
    closest?: (selector: string) => unknown;
}>;

export type NavigationFocusReturnCapture = Readonly<{
    navigate: (navigate: () => void) => void;
    cancel: () => void;
}>;

export type NavigateWithFocusReturn = ((navigate: () => void) => void) & Readonly<{
    capture: (stableTestId?: string) => NavigationFocusReturnCapture;
    navigateFrom: (stableTestId: string, navigate: () => void) => void;
    targetRef: (stableTestId: string) => React.RefCallback<Exclude<FocusReturnTarget, number | null | undefined>>;
}>;

function readActiveFocusReturnTestId(): string | null {
    if (typeof document === 'undefined') return null;
    const target = document.activeElement;
    if (!target || target === document.body || target === document.documentElement) return null;
    const testId = target.getAttribute?.('data-testid');
    return typeof testId === 'string' && testId.length > 0 ? testId : null;
}

function isVisibleEnabledFocusTarget(target: unknown): target is DomFocusReturnTarget {
    if (!target || typeof target !== 'object') return false;
    const domTarget = target as Partial<DomFocusReturnTarget>;
    if (typeof domTarget.focus !== 'function' || domTarget.isConnected === false) return false;
    if (
        domTarget.disabled === true
        || domTarget.hidden === true
        || domTarget.getAttribute?.('aria-disabled') === 'true'
        || domTarget.getAttribute?.('data-disabled') === 'true'
        || domTarget.closest?.('[hidden], [aria-hidden="true"], [inert]') != null
    ) {
        return false;
    }
    const clientRects = domTarget.getClientRects?.();
    if (clientRects && clientRects.length === 0) return false;
    const bounds = domTarget.getBoundingClientRect?.();
    if (bounds && bounds.width <= 0 && bounds.height <= 0) return false;
    return true;
}

function resolveVisibleFocusReturnTarget(stableTestId: string): DomFocusReturnTarget | null {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const matches: DomFocusReturnTarget[] = [];
    for (const candidate of Array.from(document.querySelectorAll('[data-testid]'))) {
        if (
            candidate.getAttribute('data-testid') === stableTestId
            && isVisibleEnabledFocusTarget(candidate)
        ) {
            matches.push(candidate);
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

export function useNavigationFocusReturn(options: Readonly<{ ready?: boolean }> = {}) {
    const ready = options.ready ?? true;
    const sourceId = useDestinationInstanceKey();
    const targetRef = React.useRef<FocusReturnTarget>(null);
    const nativeTargetsByTestIdRef = React.useRef(new Map<string, Exclude<FocusReturnTarget, number | null | undefined>>());
    const nativeTargetCallbacksByTestIdRef = React.useRef(new Map<
        string,
        React.RefCallback<Exclude<FocusReturnTarget, number | null | undefined>>
    >());
    const navigationIntentRef = useNavigationFocusReturnIntentRef();
    const restoreFocus = useRestoreFocusToTrigger(targetRef);

    const targetRefForTestId = React.useCallback((stableTestId: string) => {
        const existing = nativeTargetCallbacksByTestIdRef.current.get(stableTestId);
        if (existing) return existing;
        const callback: React.RefCallback<Exclude<FocusReturnTarget, number | null | undefined>> = (target) => {
            if (target) {
                nativeTargetsByTestIdRef.current.set(stableTestId, target);
            } else {
                nativeTargetsByTestIdRef.current.delete(stableTestId);
                nativeTargetCallbacksByTestIdRef.current.delete(stableTestId);
            }
        };
        nativeTargetCallbacksByTestIdRef.current.set(stableTestId, callback);
        return callback;
    }, []);

    useFocusEffect(React.useCallback(() => {
        if (!ready) return;
        const intent = navigationIntentRef.current;
        if (!intent) return;
        // Mounting/focusing a different retained page must not discard its source's return.
        if (intent.sourceId !== undefined && intent.sourceId !== sourceId) return;
        // React Native has no document-wide active-element or testID query API. The currently
        // focused screen supplies its mounted host ref for the same stable identity instead.
        const target = typeof document === 'undefined'
            ? nativeTargetsByTestIdRef.current.get(intent.testId) ?? null
            : resolveVisibleFocusReturnTarget(intent.testId);
        if (!target) {
            if (navigationIntentRef.current === intent) {
                navigationIntentRef.current = intent.previous ?? null;
            }
            return;
        }

        targetRef.current = target;
        const restored = restoreFocus();
        targetRef.current = null;
        if (restored && navigationIntentRef.current === intent) {
            navigationIntentRef.current = intent.previous ?? null;
        }
    }, [navigationIntentRef, ready, restoreFocus, sourceId]));

    const capture = React.useCallback((stableTestId?: string): NavigationFocusReturnCapture => {
        const testId = readActiveFocusReturnTestId()
            ?? (typeof document === 'undefined'
                && stableTestId
                && nativeTargetsByTestIdRef.current.has(stableTestId)
                ? stableTestId
                : null);
        if (!testId) {
            return Object.freeze({
                navigate: (navigate: () => void) => navigate(),
                cancel: () => undefined,
            });
        }

        const current = navigationIntentRef.current;
        const intent: NavigationFocusReturnIntent = { testId, ...(sourceId === null ? {} : {
            sourceId, previous: current?.sourceId === sourceId ? current.previous : current,
        }) };
        navigationIntentRef.current = intent;
        const clearIntent = () => {
            if (navigationIntentRef.current === intent) {
                navigationIntentRef.current = intent.previous ?? null;
            }
        };
        return Object.freeze({
            navigate(navigate: () => void) {
                try {
                    navigate();
                } catch (error) {
                    clearIntent();
                    throw error;
                }
            },
            cancel: clearIntent,
        });
    }, [navigationIntentRef, sourceId]);

    return React.useMemo<NavigateWithFocusReturn>(() => Object.assign(
        (navigate: () => void) => capture().navigate(navigate),
        {
            capture,
            navigateFrom: (stableTestId: string, navigate: () => void) => capture(stableTestId).navigate(navigate),
            targetRef: targetRefForTestId,
        },
    ), [capture, targetRefForTestId]);
}

/**
 * Focus return for a page that swaps its content in place (a picker pushed inside the same route, so
 * no screen focus event fires): `capture` remembers the focused control's stable test id before the
 * swap, and `restore` focuses that control again once the original content is back. A mouse press
 * leaves no keyboard ring on the restored control; keyboard users land where they were.
 */
export function useInPlaceFocusReturn() {
    const testIdRef = React.useRef<string | null>(null);
    const capture = React.useCallback(() => {
        testIdRef.current = readActiveFocusReturnTestId();
    }, []);
    const restore = React.useCallback((): boolean => {
        const testId = testIdRef.current;
        testIdRef.current = null;
        const target = testId ? resolveVisibleFocusReturnTarget(testId) : null;
        if (!target) return false;
        target.focus();
        return true;
    }, []);
    return React.useMemo(() => ({ capture, restore }), [capture, restore]);
}
