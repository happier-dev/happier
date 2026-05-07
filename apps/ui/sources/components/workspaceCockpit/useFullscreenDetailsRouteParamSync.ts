import * as React from 'react';

export type UseFullscreenDetailsRouteParamSyncInput = Readonly<{
    resetKey: string | null;
    enabled: boolean;
    isFocused: boolean;
    hydrated: boolean;
    hasRouteSelection: boolean;
    hasSelectedSelection: boolean;
    routeSelectionSignature: string;
    selectedSelectionSignature: string;
    onApplyRouteSelection: () => void;
    onWriteSelectedSelection: () => void;
}>;

export function useFullscreenDetailsRouteParamSync(input: UseFullscreenDetailsRouteParamSyncInput): void {
    const previousRouteSignatureRef = React.useRef<string | null>(null);
    const pendingRouteApplySignatureRef = React.useRef<string | null>(null);
    const pendingRouteWriteSignatureRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        previousRouteSignatureRef.current = null;
        pendingRouteApplySignatureRef.current = null;
        pendingRouteWriteSignatureRef.current = null;
    }, [input.resetKey]);

    React.useEffect(() => {
        if (!input.enabled) return;
        if (!input.isFocused) return;
        if (!input.hydrated) return;
        if (!input.hasRouteSelection) return;

        const previousRouteSignature = previousRouteSignatureRef.current;
        const routeDidChange = previousRouteSignature !== input.routeSelectionSignature;
        previousRouteSignatureRef.current = input.routeSelectionSignature;

        const pendingWriteSignature = pendingRouteWriteSignatureRef.current;
        if (pendingWriteSignature) {
            if (input.routeSelectionSignature !== pendingWriteSignature) return;
            pendingRouteWriteSignatureRef.current = null;
        }

        if (input.selectedSelectionSignature === input.routeSelectionSignature) {
            pendingRouteApplySignatureRef.current = null;
            return;
        }

        const isReconcilingCurrentRoute = pendingRouteApplySignatureRef.current === input.routeSelectionSignature;
        if (!routeDidChange && !isReconcilingCurrentRoute) return;

        input.onApplyRouteSelection();
        pendingRouteApplySignatureRef.current = input.routeSelectionSignature;
    }, [
        input.enabled,
        input.hasRouteSelection,
        input.hydrated,
        input.isFocused,
        input.onApplyRouteSelection,
        input.routeSelectionSignature,
        input.selectedSelectionSignature,
    ]);

    React.useEffect(() => {
        if (!input.enabled) return;
        if (!input.isFocused) return;
        if (!input.hydrated) return;
        if (!input.hasSelectedSelection) return;

        if (
            pendingRouteApplySignatureRef.current === input.routeSelectionSignature
            && input.selectedSelectionSignature !== input.routeSelectionSignature
        ) {
            return;
        }

        if (input.selectedSelectionSignature === input.routeSelectionSignature) {
            pendingRouteWriteSignatureRef.current = null;
            return;
        }

        pendingRouteWriteSignatureRef.current = input.selectedSelectionSignature;
        input.onWriteSelectedSelection();
    }, [
        input.enabled,
        input.hasSelectedSelection,
        input.hydrated,
        input.isFocused,
        input.onWriteSelectedSelection,
        input.routeSelectionSignature,
        input.selectedSelectionSignature,
    ]);
}
