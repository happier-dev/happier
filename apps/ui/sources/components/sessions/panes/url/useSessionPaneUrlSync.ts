import * as React from 'react';

import type { SessionPaneUrlState } from './sessionPaneUrlState';
import {
    deriveSessionPaneUrlStateFromScopeState,
    reconcileSessionPaneScopeFromUrlState,
    serializeSessionPaneUrlState,
} from './sessionPaneUrlState';

export type UseSessionPaneUrlSyncInput = Readonly<{
    enabled: boolean;
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        closeRight: () => void;
        setRightTab: (tabId: string) => void;
        openDetailsTab: (tab: any, options?: any) => void;
        closeDetails: () => void;
    }>;
    scopeState: unknown;
    urlState: SessionPaneUrlState | null;
    setParams: ((params: Record<string, unknown>) => void) | null | undefined;
}>;

function signatureFromSerialized(params: Readonly<{ right?: unknown; details?: unknown; path?: unknown; sha?: unknown }>): string {
    return `${String(params.right ?? '')}|${String(params.details ?? '')}|${String(params.path ?? '')}|${String(params.sha ?? '')}`;
}

function serializeToParamShape(state: SessionPaneUrlState | null): Readonly<{ right?: string; details?: string; path?: string; sha?: string }> {
    const serialized = state ? serializeSessionPaneUrlState(state) : {};
    return {
        right: serialized.right,
        details: serialized.details,
        path: serialized.path,
        sha: serialized.sha,
    };
}

export function useSessionPaneUrlSync(input: UseSessionPaneUrlSyncInput): void {
    const pendingUrlWriteRef = React.useRef<null | Readonly<{ fromSig: string; toSig: string }>>(null);
    const pendingPaneReconcileRef = React.useRef<null | Readonly<{ targetUrlSig: string }>>(null);
    const prevUrlSigRef = React.useRef<string | null>(null);
    const prevDerivedSigRef = React.useRef<string | null>(null);

    const derivedState = React.useMemo(() => deriveSessionPaneUrlStateFromScopeState((input.scopeState ?? null) as any), [input.scopeState]);
    const derivedParams = React.useMemo(() => serializeToParamShape(derivedState), [derivedState]);
    const urlParams = React.useMemo(() => serializeToParamShape(input.urlState), [input.urlState]);
    const derivedSig = React.useMemo(() => signatureFromSerialized(derivedParams), [derivedParams]);
    const urlSig = React.useMemo(() => signatureFromSerialized(urlParams), [urlParams]);

    React.useEffect(() => {
        if (!input.enabled) return;
        const prevUrlSig = prevUrlSigRef.current;
        const prevDerivedSig = prevDerivedSigRef.current;
        const isFirstRun = prevUrlSig === null && prevDerivedSig === null;

        prevUrlSigRef.current = urlSig;
        prevDerivedSigRef.current = derivedSig;

        const pending = pendingUrlWriteRef.current;
        if (pending) {
            // The URL has not yet reflected the params we wrote (still on the old signature).
            if (urlSig === pending.fromSig) {
                return;
            }
            // The URL now reflects the params we wrote; clear pending state and ignore.
            if (urlSig === pending.toSig) {
                pendingUrlWriteRef.current = null;
                return;
            }
            // URL moved somewhere else (e.g. user navigation); clear pending and handle normally.
            pendingUrlWriteRef.current = null;
        }

        const pendingReconcile = pendingPaneReconcileRef.current;
        if (pendingReconcile) {
            // Once the URL changes away from what we were trying to reconcile, drop the pending state.
            if (urlSig !== pendingReconcile.targetUrlSig) {
                pendingPaneReconcileRef.current = null;
            } else if (derivedSig !== urlSig) {
                // We recently reconciled pane state from the URL, but the scope state has not yet
                // reflected the update. Do not immediately write derived state back into the URL;
                // this prevents StrictMode double-invocation from clearing the user's deep-link.
                return;
            } else {
                pendingPaneReconcileRef.current = null;
            }
        }

        // Initial mount: if the URL includes pane params, apply them into pane state.
        if (isFirstRun && input.urlState) {
            reconcileSessionPaneScopeFromUrlState(input.pane, input.urlState);
            pendingPaneReconcileRef.current = { targetUrlSig: urlSig };
            return;
        }

        // Browser back/forward: URL changed without us writing it.
        if (prevUrlSig !== null && urlSig !== prevUrlSig) {
            reconcileSessionPaneScopeFromUrlState(input.pane, input.urlState);
            pendingPaneReconcileRef.current = { targetUrlSig: urlSig };
            return;
        }

        if (!input.setParams) return;
        if (derivedSig === urlSig) return;

        // Pane state changed (or initial empty URL): serialize state back into the URL.
        pendingUrlWriteRef.current = { fromSig: urlSig, toSig: derivedSig };
        input.setParams({
            right: derivedParams.right,
            details: derivedParams.details,
            path: derivedParams.path,
            sha: derivedParams.sha,
        });
    }, [
        derivedParams.details,
        derivedParams.path,
        derivedParams.right,
        derivedParams.sha,
        derivedSig,
        input.enabled,
        input.pane,
        input.setParams,
        input.urlState,
        urlSig,
    ]);
}
