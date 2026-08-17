import * as React from 'react';

/**
 * Live composer text for one new-session screen instance, owned outside the React
 * render graph.
 *
 * The new-session screen model is a large hook tree (~1,900 lines, ~36 memos across its
 * sub-hooks). While the prompt was `React.useState` inside that tree, every keystroke
 * re-executed the whole model, rebuilt the authoring draft and authoring context, and
 * invalidated both screen-variant prop bundles — for a value that only the composer input
 * and a handful of imperative callbacks (submit, send, draft persistence) actually read.
 *
 * The store keeps the composer fully controlled and fully live: the input subscribes
 * with `useNewSessionPromptValue` and re-renders on every keystroke, exactly as before,
 * while everything that only needs the text *at call time* reads `getPrompt()` from a
 * stable handle instead of taking a render dependency on it.
 */
export type NewSessionPromptStore = Readonly<{
    /** Current live text. Safe to call from render or from an imperative callback. */
    getPrompt: () => string;
    /** Update the live text. Identical text is a no-op and notifies nobody. */
    setPrompt: (next: React.SetStateAction<string>) => void;
    /** Subscribe to text changes without rendering the owner. Returns an unsubscribe. */
    subscribe: (listener: () => void) => () => void;
}>;

export function createNewSessionPromptStore(initialPrompt: string): NewSessionPromptStore {
    let prompt = initialPrompt;
    const listeners = new Set<() => void>();

    const getPrompt = (): string => prompt;

    const setPrompt = (next: React.SetStateAction<string>): void => {
        const resolved = typeof next === 'function' ? next(prompt) : next;
        if (resolved === prompt) {
            return;
        }
        prompt = resolved;
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

/** Create the screen instance's prompt store once, seeded from the hydrated draft text. */
export function useNewSessionPromptStore(getInitialPrompt: () => string): NewSessionPromptStore {
    const storeRef = React.useRef<NewSessionPromptStore | null>(null);
    if (storeRef.current === null) {
        storeRef.current = createNewSessionPromptStore(getInitialPrompt());
    }
    return storeRef.current;
}

/**
 * Subscribe to the live text. Call this in the leaf that renders the composer input so
 * that typing re-renders the input and nothing above it.
 */
export function useNewSessionPromptValue(store: NewSessionPromptStore): string {
    return React.useSyncExternalStore(store.subscribe, store.getPrompt, store.getPrompt);
}
