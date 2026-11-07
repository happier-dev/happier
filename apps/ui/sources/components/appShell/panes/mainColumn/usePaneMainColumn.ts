import * as React from 'react';

/**
 * What the restore chip shows for a hidden main column (lab H1–H3): the host's mark and name, and
 * its live state from the host's own lifecycle projection (`working` ring, `attention` = Needs you).
 */
export type PaneMainIdentity = Readonly<{
    mark?: React.ReactNode;
    name: string;
    state?: 'working' | 'attention';
}>;

export type PaneMainColumnDescriptor = Readonly<{
    hideLabel: string;
    showLabel: string;
    identity: PaneMainIdentity;
}>;

export type PaneMainColumnState = Readonly<{
    hidden: boolean;
    canHide: boolean;
    folded: boolean;
    labels: Readonly<{ hideLabel: string; showLabel: string }>;
    identity: PaneMainIdentity;
    setHidden(hidden: boolean): void;
    /** Explicit Hide/Restore intent; policy and approval precede the raw setter. */
    requestHidden(hidden: boolean): void;
    toggle(): void;
}>;

export const PaneMainColumnContext = React.createContext<PaneMainColumnState | null>(null);

/** Every destination consumes its enclosing measured pane host, including app/plugin pages. */
export function usePaneMainColumn(): PaneMainColumnState | null {
    return React.useContext(PaneMainColumnContext);
}

/**
 * Which headers have drawn the hidden column's restore chip. Every pane header may draw it; the host
 * draws a fallback chip only while none did, so a hidden main column never leaves a blank page with
 * no way back. One store per pane host.
 */
export type PaneMainChipClaims = Readonly<{
    claim(): () => void;
    subscribe(listener: () => void): () => void;
    isClaimed(): boolean;
}>;

export function createPaneMainChipClaims(): PaneMainChipClaims {
    let count = 0;
    const listeners = new Set<() => void>();
    return {
        claim() {
            count += 1;
            listeners.forEach((listener) => listener());
            return () => {
                count -= 1;
                listeners.forEach((listener) => listener());
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        isClaimed: () => count > 0,
    };
}

export const PaneMainChipClaimsContext = React.createContext<PaneMainChipClaims | null>(null);
