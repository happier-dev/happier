import * as React from 'react';
import { useFocusEffect } from '@react-navigation/native';

import {
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
    capture: () => NavigationFocusReturnCapture;
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
    const targetRef = React.useRef<DomFocusReturnTarget | null>(null);
    const navigationIntentRef = useNavigationFocusReturnIntentRef();
    const restoreFocus = useRestoreFocusToTrigger(targetRef);

    useFocusEffect(React.useCallback(() => {
        if (!ready) return;
        const intent = navigationIntentRef.current;
        if (!intent) return;
        const target = resolveVisibleFocusReturnTarget(intent.testId);
        if (!target) {
            if (navigationIntentRef.current === intent) {
                navigationIntentRef.current = null;
            }
            return;
        }

        targetRef.current = target;
        const restored = restoreFocus();
        targetRef.current = null;
        if (restored && navigationIntentRef.current === intent) {
            navigationIntentRef.current = null;
        }
    }, [navigationIntentRef, ready, restoreFocus]));

    const capture = React.useCallback((): NavigationFocusReturnCapture => {
        const testId = readActiveFocusReturnTestId();
        if (!testId) {
            return Object.freeze({
                navigate: (navigate: () => void) => navigate(),
                cancel: () => undefined,
            });
        }

        const intent: NavigationFocusReturnIntent = { testId };
        navigationIntentRef.current = intent;
        const clearIntent = () => {
            if (navigationIntentRef.current === intent) {
                navigationIntentRef.current = null;
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
    }, [navigationIntentRef]);

    return React.useMemo<NavigateWithFocusReturn>(() => Object.assign(
        (navigate: () => void) => capture().navigate(navigate),
        { capture },
    ), [capture]);
}
