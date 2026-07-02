import * as React from 'react';

import { restoreFocusToBestTarget, useFocusReturnFallbackRef, type FocusReturnRef, type FocusReturnTarget } from './focusReturn';

const ESCAPE_EVENT_HANDLED_KEY = '__happierEscapeEventHandled';

export const ESCAPE_LAYER_PRIORITIES = {
    focusSessionSurface: 10,
    sessionListSelection: 15,
    draftClear: 20,
    pane: 100,
    overlay: 200,
    composerSuggestions: 300,
    popover: 400,
    commandPalette: 500,
    modal: 600,
} as const;

export const ESCAPE_KEY_BLOCKER_PRIORITIES = {
    panes: ESCAPE_LAYER_PRIORITIES.pane,
    bottomPane: ESCAPE_LAYER_PRIORITIES.overlay,
} as const;

type EscapeLayerEntry = Readonly<{
    id: number;
    priority: number;
    allowEditableTarget: boolean;
    onEscape: (event: unknown) => boolean | void;
}>;

type EscapeKeyBlockerEntry = Readonly<{
    id: number;
    priority: number;
}>;

export type EscapeLayerOptions = Readonly<{
    priority: number;
    enabled?: boolean;
    allowEditableTarget?: boolean;
    focusReturnRef?: FocusReturnRef;
    focusFallbackRef?: FocusReturnRef;
    onEscape: (event: unknown) => boolean | void;
}>;

let nextEscapeEntryId = 1;
let escapeLayers: ReadonlyArray<EscapeLayerEntry> = [];
let escapeKeyBlockers: ReadonlyArray<EscapeKeyBlockerEntry> = [];

export function markEscapeEventHandled(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    try {
        (event as Record<string, unknown>)[ESCAPE_EVENT_HANDLED_KEY] = true;
    } catch {
        // Some platform events are readonly/frozen.
    }
}

export function isEscapeEventHandled(event: unknown): boolean {
    if (!event || typeof event !== 'object') return false;
    return (event as Record<string, unknown>)[ESCAPE_EVENT_HANDLED_KEY] === true;
}

function isEscapeKeyEvent(event: unknown): boolean {
    return Boolean(event && typeof event === 'object' && (event as { key?: unknown }).key === 'Escape');
}

function isEditableEscapeTarget(target: unknown): boolean {
    if (!target || typeof target !== 'object') return false;
    const element = target as {
        tagName?: unknown;
        isContentEditable?: boolean;
        closest?: (selector: string) => unknown;
    };
    const tagName = String(element.tagName ?? '').toLowerCase();
    return tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || element.isContentEditable === true
        || element.closest?.('[contenteditable="true"], [data-keyboard-shortcuts-owned="true"]') != null;
}

function stopEscapeEvent(event: unknown): void {
    const stoppable = event as {
        preventDefault?: () => void;
        stopPropagation?: () => void;
        stopImmediatePropagation?: () => void;
    } | null | undefined;
    stoppable?.preventDefault?.();
    stoppable?.stopPropagation?.();
    stoppable?.stopImmediatePropagation?.();
}

export function getMaxEscapeKeyBlockerPriority(): number {
    let max = 0;
    for (const blocker of escapeKeyBlockers) {
        if (blocker.priority > max) max = blocker.priority;
    }
    for (const layer of escapeLayers) {
        if (layer.priority > max) max = layer.priority;
    }
    return max;
}

export function registerEscapeKeyBlocker(priority: number): () => void {
    const id = nextEscapeEntryId++;
    const entry: EscapeKeyBlockerEntry = { id, priority };
    escapeKeyBlockers = [...escapeKeyBlockers, entry];

    return () => {
        escapeKeyBlockers = escapeKeyBlockers.filter((blocker) => blocker.id !== id);
    };
}

export function registerEscapeLayer(options: EscapeLayerOptions): () => void {
    if (options.enabled === false) return () => {};
    const id = nextEscapeEntryId++;
    const entry: EscapeLayerEntry = {
        id,
        priority: options.priority,
        allowEditableTarget: options.allowEditableTarget === true,
        onEscape: (event) => {
            const handled = options.onEscape(event);
            if (handled !== false && options.focusReturnRef) {
                restoreFocusToBestTarget(options.focusReturnRef, options.focusFallbackRef);
            }
            return handled;
        },
    };
    escapeLayers = [...escapeLayers, entry];

    return () => {
        escapeLayers = escapeLayers.filter((layer) => layer.id !== id);
    };
}

export function dispatchEscapeToLayerStack(event: unknown): boolean {
    if (!isEscapeKeyEvent(event)) return false;
    if (isEscapeEventHandled(event)) return false;

    const target = (event as { target?: unknown } | null | undefined)?.target;
    const editableTarget = isEditableEscapeTarget(target);
    const layers = [...escapeLayers].sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.id - a.id;
    });

    for (const layer of layers) {
        if (editableTarget && !layer.allowEditableTarget) continue;
        const handled = layer.onEscape(event);
        if (handled === false) continue;
        markEscapeEventHandled(event);
        stopEscapeEvent(event);
        return true;
    }

    return false;
}

export function useEscapeLayer(options: EscapeLayerOptions): void {
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    const contextFallbackRef = useFocusReturnFallbackRef<FocusReturnTarget>();

    React.useEffect(() => {
        if (options.enabled === false) return;
        const unregister = registerEscapeLayer({
            ...options,
            focusFallbackRef: options.focusFallbackRef ?? contextFallbackRef,
            onEscape: (event) => optionsRef.current.onEscape(event),
        });
        const maybeWindow: unknown = typeof window !== 'undefined' ? window : null;
        const maybeDocument: unknown = typeof document !== 'undefined' ? document : null;
        const target =
            isEscapeEventTarget(maybeWindow)
                ? maybeWindow
                : isEscapeEventTarget(maybeDocument)
                    ? maybeDocument
                    : null;
        if (target === null) return unregister;

        const handleKeyDownCapture: EventListener = (event) => {
            dispatchEscapeToLayerStack(event);
        };
        target.addEventListener('keydown', handleKeyDownCapture, true);

        return () => {
            target.removeEventListener('keydown', handleKeyDownCapture, true);
            unregister();
        };
    }, [
        options.allowEditableTarget,
        options.enabled,
        options.focusFallbackRef,
        options.focusReturnRef,
        options.priority,
        contextFallbackRef,
    ]);
}

function isEscapeEventTarget(value: unknown): value is EventTarget {
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as {
        addEventListener?: unknown;
        removeEventListener?: unknown;
    };
    return (
        typeof candidate.addEventListener === 'function' &&
        typeof candidate.removeEventListener === 'function'
    );
}
