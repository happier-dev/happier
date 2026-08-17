import * as React from 'react';
import { AccessibilityInfo, findNodeHandle, Platform } from 'react-native';

type FocusableFocusReturnTarget = Readonly<{
    focus?: () => void;
    isConnected?: boolean;
}>;

/** A React Native event target is a native host tag, not a JS host ref. */
export type NativeFocusReturnTarget = number;

export type FocusReturnTarget = FocusableFocusReturnTarget | NativeFocusReturnTarget | null | undefined;

export type FocusReturnRef = Readonly<{
    current: FocusReturnTarget;
}> | null | undefined;

/** A host-owned ephemeral focus handoff; never persisted with pane state. */
export type FocusReturnMutableRef = React.MutableRefObject<FocusReturnTarget>;

export type NavigationFocusReturnIntent = Readonly<{
    testId: string;
}>;

type FocusReturnContextValue = Readonly<{
    fallbackRef: React.MutableRefObject<FocusReturnTarget>;
    navigationIntentRef: React.MutableRefObject<NavigationFocusReturnIntent | null>;
}>;

const FocusReturnContext = React.createContext<FocusReturnContextValue | null>(null);

function canFocusTarget(target: unknown): target is FocusableFocusReturnTarget & { focus: () => void } {
    if (typeof target !== 'object' || target === null) return false;
    const candidate = target as Readonly<{ focus?: unknown; isConnected?: unknown }>;
    return typeof candidate.focus === 'function' && candidate.isConnected !== false;
}

function isCurrentFocusTarget(target: FocusReturnTarget): target is FocusableFocusReturnTarget {
    return typeof target === 'object' && target !== null && target.isConnected !== false;
}

function isNativeFocusTarget(target: FocusReturnTarget): target is NativeFocusReturnTarget {
    return typeof target === 'number' && Number.isInteger(target) && target > 0;
}

function isRestorableFocusTarget(target: FocusReturnTarget): target is NonNullable<FocusReturnTarget> {
    return isNativeFocusTarget(target) || isCurrentFocusTarget(target);
}

/**
 * Moves native accessibility focus to a current host ref or native event tag.
 * This complements a physical `.focus()` call: native View hosts do not all
 * expose that method.
 */
export function focusNativeAccessibilityTarget(target: FocusReturnTarget): boolean {
    if (Platform.OS === 'web') return false;

    try {
        const reactTag = isNativeFocusTarget(target)
            ? target
            : isCurrentFocusTarget(target)
                ? findNodeHandle(target as never)
                : null;
        if (typeof reactTag !== 'number') return false;
        AccessibilityInfo.setAccessibilityFocus(reactTag);
        return true;
    } catch {
        return false;
    }
}

function focusTarget(target: FocusReturnTarget): boolean {
    if (isNativeFocusTarget(target)) {
        return focusNativeAccessibilityTarget(target);
    }
    if (!isCurrentFocusTarget(target)) return false;
    const focus = target.focus;
    let physicalFocusSucceeded = false;

    if (typeof focus === 'function') {
        try {
            focus.call(target);
            physicalFocusSucceeded = true;
        } catch {
            physicalFocusSucceeded = false;
        }
    }

    if (Platform.OS !== 'web') {
        return focusNativeAccessibilityTarget(target) || physicalFocusSucceeded;
    }

    if (!physicalFocusSucceeded) return false;

    // A measurable RNW wrapper has a DOM `.focus()` method even when it is not
    // keyboard-focusable. Treat that no-op as a failed return so the caller can
    // continue to its next canonical target instead of stranding focus on BODY.
    if (typeof document === 'undefined' || typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
        return true;
    }
    const activeElement = document.activeElement;
    return activeElement === target || target.contains(activeElement);
}

/**
 * Snapshot a browser's current focus target before a state transition mutates
 * its DOM eligibility. Callers own when that transition begins; this helper
 * deliberately stores no DOM identity itself.
 */
export function readDocumentFocusReturnTarget(doc: Document): FocusReturnTarget {
    const activeElement = doc.activeElement;
    if (!activeElement || activeElement === doc.body || activeElement === doc.documentElement) {
        return null;
    }
    return canFocusTarget(activeElement) ? activeElement : null;
}

export function restoreFocusToBestTarget(
    triggerRef: FocusReturnRef,
    fallbackRef?: FocusReturnRef,
): boolean {
    const trigger = triggerRef?.current;
    if (isRestorableFocusTarget(trigger)) {
        if (focusTarget(trigger)) return true;
    }

    const fallback = fallbackRef?.current;
    if (isRestorableFocusTarget(fallback)) {
        if (focusTarget(fallback)) return true;
    }

    return false;
}

export function FocusReturnProvider(props: React.PropsWithChildren) {
    const fallbackRef = React.useRef<FocusReturnTarget>(null);
    const navigationIntentRef = React.useRef<NavigationFocusReturnIntent | null>(null);
    const value = React.useMemo<FocusReturnContextValue>(() => ({
        fallbackRef,
        navigationIntentRef,
    }), []);
    return (
        <FocusReturnContext.Provider value={value}>
            {props.children}
        </FocusReturnContext.Provider>
    );
}

export function useFocusReturnFallbackRef<T extends FocusReturnTarget>() {
    const context = React.useContext(FocusReturnContext);
    const localFallbackRef = React.useRef<FocusReturnTarget>(null);
    const fallbackRef = context?.fallbackRef ?? localFallbackRef;
    return fallbackRef as React.MutableRefObject<T>;
}

export function useNavigationFocusReturnIntentRef() {
    const context = React.useContext(FocusReturnContext);
    const localIntentRef = React.useRef<NavigationFocusReturnIntent | null>(null);
    return context?.navigationIntentRef ?? localIntentRef;
}

export function useRestoreFocusToTrigger(triggerRef: FocusReturnRef) {
    const context = React.useContext(FocusReturnContext);
    return React.useCallback(() => {
        return restoreFocusToBestTarget(triggerRef, context?.fallbackRef);
    }, [context?.fallbackRef, triggerRef]);
}
