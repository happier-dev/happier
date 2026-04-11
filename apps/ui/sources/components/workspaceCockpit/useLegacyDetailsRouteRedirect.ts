import * as React from 'react';

type DetailsTabLike = Readonly<{ key?: string | null }> | null | undefined;

export function useLegacyDetailsRouteRedirect(input: Readonly<{
    resetKey: string | null;
    enabled: boolean;
    isFocused: boolean;
    detailsIsOpen: boolean;
    activeDetailsKey: string | null;
    detailsTabs: readonly DetailsTabLike[];
    onNavigate: (activeKey: string) => void;
}>): void {
    const lastPushedDetailsKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        lastPushedDetailsKeyRef.current = null;
    }, [input.resetKey]);

    React.useEffect(() => {
        if (!input.detailsIsOpen) {
            lastPushedDetailsKeyRef.current = null;
            return;
        }
        if (!input.enabled) return;
        if (!input.isFocused) return;
        if (!input.detailsTabs.length) return;

        const fallbackKeyCandidate = input.detailsTabs.at(-1)?.key;
        const fallbackKey = typeof fallbackKeyCandidate === 'string' ? fallbackKeyCandidate : null;
        const activeKey = typeof input.activeDetailsKey === 'string' && input.activeDetailsKey
            ? input.activeDetailsKey
            : fallbackKey;

        if (!activeKey) return;
        if (lastPushedDetailsKeyRef.current === activeKey) return;

        lastPushedDetailsKeyRef.current = activeKey;
        input.onNavigate(activeKey);
    }, [
        input.activeDetailsKey,
        input.detailsIsOpen,
        input.detailsTabs,
        input.enabled,
        input.isFocused,
        input.onNavigate,
    ]);
}
