import * as React from 'react';

/**
 * Live composer text for one mounted composer, owned outside the React render graph.
 *
 * Composer text is high-frequency state. Held in `React.useState` inside a screen-level owner
 * (the New Session screen model, the loaded Session view), every keystroke re-ran that whole
 * owner for a value that only the composer input and a few imperative callbacks (submit, send,
 * draft persistence) read.
 *
 * The store keeps the composer fully controlled and fully live: the input leaf subscribes with
 * `useComposerTextValue` and re-renders on every keystroke, while everything that only needs the
 * text *at call time* reads `getPrompt()` from a stable handle, and an owner that must react to a
 * *semantic* change of the text (empty/non-empty, a restore basis becoming applicable) subscribes
 * with a selector that returns the same value while that meaning holds.
 */
export type ComposerTextStore = Readonly<{
    /** Current live text. Safe to call from render or from an imperative callback. */
    getPrompt: () => string;
    /** Update the live text. Identical text is a no-op and notifies nobody. */
    setPrompt: (next: React.SetStateAction<string>) => void;
    /** Subscribe to text changes without rendering the owner. Returns an unsubscribe. */
    subscribe: (listener: () => void) => () => void;
}>;

export function createComposerTextStore(initialText: string): ComposerTextStore {
    let text = initialText;
    const listeners = new Set<() => void>();

    const getPrompt = (): string => text;

    const setPrompt = (next: React.SetStateAction<string>): void => {
        const resolved = typeof next === 'function' ? next(text) : next;
        if (resolved === text) {
            return;
        }
        text = resolved;
        for (const listener of Array.from(listeners)) {
            listener();
        }
    };

    const subscribe = (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };

    return { getPrompt, setPrompt, subscribe };
}

/** Create the composer instance's text store once, seeded from `getInitialText`. */
export function useComposerTextStore(getInitialText: () => string): ComposerTextStore {
    const storeRef = React.useRef<ComposerTextStore | null>(null);
    if (storeRef.current === null) {
        storeRef.current = createComposerTextStore(getInitialText());
    }
    return storeRef.current;
}

/**
 * Subscribe to the live text. Call this in the leaf that renders the composer input so that
 * typing re-renders the input and nothing above it.
 */
export function useComposerTextValue(store: ComposerTextStore): string {
    return React.useSyncExternalStore(store.subscribe, store.getPrompt, store.getPrompt);
}
