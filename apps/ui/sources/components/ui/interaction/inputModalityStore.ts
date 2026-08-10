import * as React from 'react';

/**
 * Which input device the person is currently driving the app with.
 *
 * React Native has no `:focus-visible`, so a focus ring wired straight to `onFocus` appears on
 * every tap — which is worse than no ring at all, because it teaches people to ignore it. This is
 * the missing half: focus decides WHERE the ring goes, modality decides WHETHER it is drawn.
 *
 * The default is `'pointer'`, and it is deliberate: a runtime with no keyboard to listen to (every
 * native build) stays on pointer forever and therefore never rings. The web/desktop runtimes are
 * the ones that can observe a keypress, and they are the ones where the ring is wanted.
 *
 * One listener set for the whole process, attached lazily on the first reader and kept for the
 * process lifetime — the same shape and for the same reason as
 * `hooks/ui/useReducedMotionPreference.ts`: hundreds of pressables mount, one host property.
 */
export type InputModality = 'pointer' | 'keyboard';

type DomEventTargetLike = Readonly<{
    addEventListener?: (type: string, listener: (event: unknown) => void, capture?: boolean) => void;
}>;

/**
 * `pointerdown` covers mouse, pen and touch in every modern engine; the other two are there for
 * runtimes that never shipped pointer events.
 */
const POINTER_EVENT_TYPES = ['pointerdown', 'mousedown', 'touchstart'] as const;

/**
 * A bare modifier press is not navigation — holding Shift before clicking a row must not arm the
 * ring. Every other key does, matching what `:focus-visible` does for typing into a field.
 */
const NON_NAVIGATION_KEYS = new Set([
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Fn',
    'FnLock',
    'Hyper',
    'Meta',
    'NumLock',
    'OS',
    'ScrollLock',
    'Shift',
    'Super',
    'Symbol',
    'SymbolLock',
]);

let modality: InputModality = 'pointer';
let watching = false;
const listeners = new Set<() => void>();

function publish(next: InputModality): void {
    if (modality === next) return;
    modality = next;
    for (const listener of [...listeners]) {
        listener();
    }
}

function resolveEventTarget(): DomEventTargetLike | null {
    const candidate = (globalThis as { document?: DomEventTargetLike }).document;
    return typeof candidate?.addEventListener === 'function' ? candidate : null;
}

function ensureWatching(): void {
    if (watching) return;
    // Marked watched even when there is no DOM: a native runtime will not grow one later, and
    // re-probing on every read would cost more than it could ever discover.
    watching = true;

    const target = resolveEventTarget();
    if (!target?.addEventListener) return;

    // Capture phase, so the modality is already correct by the time a focus handler reads it.
    target.addEventListener('keydown', (event) => {
        const key = (event as { key?: unknown }).key;
        if (typeof key === 'string' && NON_NAVIGATION_KEYS.has(key)) return;
        publish('keyboard');
    }, true);

    for (const type of POINTER_EVENT_TYPES) {
        target.addEventListener(type, () => publish('pointer'), true);
    }
}

export function getInputModality(): InputModality {
    ensureWatching();
    return modality;
}

export function subscribeToInputModality(listener: () => void): () => void {
    ensureWatching();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useInputModality(): InputModality {
    return React.useSyncExternalStore(subscribeToInputModality, getInputModality, getInputModality);
}

export function useIsKeyboardModality(): boolean {
    return useInputModality() === 'keyboard';
}
