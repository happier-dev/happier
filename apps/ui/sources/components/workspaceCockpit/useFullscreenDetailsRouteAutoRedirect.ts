import * as React from 'react';

import type { FullscreenDetailsRouteSelection } from './resolveFullscreenDetailsRouteSelection';

export function useFullscreenDetailsRouteAutoRedirect(input: Readonly<{
    resetKey: string | null;
    enabled: boolean;
    isFocused: boolean;
    detailsIsOpen: boolean;
    detailsSelection: FullscreenDetailsRouteSelection;
    onNavigate: (activeKey: string) => void;
}>): void {
    const lastPushedDetailsKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        lastPushedDetailsKeyRef.current = null;
    }, [input.resetKey]);

    React.useEffect(() => {
        if (!input.detailsIsOpen || !input.detailsSelection.hasAnyDetails) {
            lastPushedDetailsKeyRef.current = null;
            return;
        }
        if (!input.enabled) return;
        if (!input.isFocused) return;

        const activeKey = input.detailsSelection.activeKey;
        if (!activeKey) return;
        if (lastPushedDetailsKeyRef.current === activeKey) return;

        lastPushedDetailsKeyRef.current = activeKey;
        input.onNavigate(activeKey);
    }, [
        input.detailsIsOpen,
        input.detailsSelection.activeKey,
        input.detailsSelection.hasAnyDetails,
        input.enabled,
        input.isFocused,
        input.onNavigate,
    ]);
}
