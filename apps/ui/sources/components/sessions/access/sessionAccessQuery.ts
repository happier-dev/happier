import * as React from 'react';

/**
 * The typed access search of one access editor controller.
 *
 * A controller is often mounted far above its editor (the Collaboration pane hosts one
 * controller for the access card and the Share panel), so keeping the text in that host's
 * render state re-rendered the whole pane on every key. The controller owns this store
 * instead; only the editor subscribes, so a key re-renders the field and its result list.
 */
export type SessionAccessQuery = Readonly<{
    read(): string;
    write(query: string): void;
    subscribe(listener: () => void): () => void;
}>;

export function createSessionAccessQuery(initial = ''): SessionAccessQuery {
    let current = initial;
    const listeners = new Set<() => void>();
    return {
        read: () => current,
        write: (query) => {
            if (query === current) return;
            current = query;
            for (const listener of [...listeners]) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

const EMPTY_QUERY = createSessionAccessQuery();

/** The current text, for the one component that renders the field and its results. */
export function useSessionAccessQueryText(query: SessionAccessQuery | undefined): string {
    const source = query ?? EMPTY_QUERY;
    return React.useSyncExternalStore(source.subscribe, source.read, source.read);
}
