import * as React from 'react';
import {
    consumeSessionPaneHistoryTraversalForCurrentLocation,
    primeSessionPaneHistoryTraversalTracking,
    readCurrentSessionPaneHistoryState,
    scheduleCurrentSessionPaneHistoryState,
} from './sessionPaneHistoryState';
import { readStoredSessionPaneUrlState, writeStoredSessionPaneUrlState } from './sessionPaneStoredState';
import { pushSessionPaneUrlParams } from './pushSessionPaneUrlParams';

import type { SessionPaneUrlState } from './sessionPaneUrlState';
import {
    applySessionPaneUrlState,
    deriveSessionPaneUrlStateFromScopeState,
    reconcileSessionPaneScopeFromUrlState,
    serializeSessionPaneUrlState,
} from './sessionPaneUrlState';

export type UseSessionPaneUrlSyncInput = Readonly<{
    enabled: boolean;
    routeParamSyncEnabled?: boolean;
    /**
     * Stable key for the pane scope being synced (e.g. `session:<id>`). When this changes,
     * the hook must treat the next effect cycle as a fresh mount so we don't reconcile the
     * *new* scope's pane state based on the *previous* scope's URL signature.
     */
    scopeKey?: string;
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        closeRight: () => void;
        setRightTab: (tabId: string) => void;
        openBottom: (options?: Readonly<{ tabId?: string }>) => void;
        closeBottom: () => void;
        setBottomTab: (tabId: string) => void;
        openDetailsTab: (tab: any, options?: any) => void;
        closeDetails: () => void;
    }>;
    scopeState: unknown;
    urlState: SessionPaneUrlState | null;
    setParams: ((params: Record<string, unknown>) => void) | null | undefined;
}>;

function signatureFromSerialized(
    params: Readonly<{ right?: unknown; bottom?: unknown; details?: unknown; path?: unknown; sha?: unknown; terminalInstanceId?: unknown }>,
): string {
    return `${String(params.right ?? '')}|${String(params.bottom ?? '')}|${String(params.details ?? '')}|${String(params.path ?? '')}|${String(params.sha ?? '')}|${String(params.terminalInstanceId ?? '')}`;
}

function serializeToParamShape(
    state: SessionPaneUrlState | null,
): Readonly<{ right?: string; bottom?: string; details?: string; path?: string; sha?: string; terminalInstanceId?: string }> {
    const serialized = state ? serializeSessionPaneUrlState(state) : {};
    return {
        right: serialized.right,
        bottom: serialized.bottom,
        details: serialized.details,
        path: serialized.path,
        sha: serialized.sha,
        terminalInstanceId: serialized.terminalInstanceId,
    };
}

function readSessionIdFromScopeKey(scopeKey: string): string | null {
    if (!scopeKey.startsWith('session:')) return null;
    const sessionId = scopeKey.slice('session:'.length).trim();
    return sessionId.length > 0 ? sessionId : null;
}

function canWriteSessionPaneParamsForCurrentBrowserUrl(scopeKey: string): boolean {
    if (typeof window === 'undefined') return true;

    const href = window.location?.href;
    if (typeof href !== 'string') return false;

    const expectedSessionId = readSessionIdFromScopeKey(scopeKey);
    if (!expectedSessionId) return false;

    try {
        const url = new URL(href);
        const match = /^\/session\/([^/]+)\/?$/.exec(url.pathname);
        if (!match) return false;
        return decodeURIComponent(match[1] ?? '') === expectedSessionId;
    } catch {
        return false;
    }
}

export function useSessionPaneUrlSync(input: UseSessionPaneUrlSyncInput): void {
    primeSessionPaneHistoryTraversalTracking();

    const pendingUrlWriteRef = React.useRef<null | Readonly<{ fromSig: string; toSig: string }>>(null);
    const pendingPaneReconcileRef = React.useRef<null | Readonly<{ targetUrlSig: string }>>(null);
    const prevUrlSigRef = React.useRef<string | null>(null);
    const prevDerivedSigRef = React.useRef<string | null>(null);
    const prevScopeKeyRef = React.useRef<string | null>(null);
    const restoredScopeKeyRef = React.useRef<string | null>(null);
    const storedStateHydratedScopeKeyRef = React.useRef<string | null>(null);
    const pendingStoredStateWriteSigRef = React.useRef<string | null>(null);
    const routeParamSyncEnabled = input.routeParamSyncEnabled !== false;

    const derivedState = React.useMemo(() => deriveSessionPaneUrlStateFromScopeState((input.scopeState ?? null) as any), [input.scopeState]);
    const derivedParams = React.useMemo(() => serializeToParamShape(derivedState), [derivedState]);
    const urlParams = React.useMemo(() => serializeToParamShape(input.urlState), [input.urlState]);
    const derivedSig = React.useMemo(() => signatureFromSerialized(derivedParams), [derivedParams]);
    const urlSig = React.useMemo(() => signatureFromSerialized(urlParams), [urlParams]);
    const scopeKey = input.scopeKey ?? 'default';
    const currentHistoryPaneState = React.useMemo(() => readCurrentSessionPaneHistoryState(scopeKey), [scopeKey, urlSig]);
    const storedState = React.useMemo(() => {
        if (routeParamSyncEnabled && input.urlState) return null;
        return readStoredSessionPaneUrlState(scopeKey);
    }, [input.urlState, routeParamSyncEnabled, scopeKey]);

    React.useEffect(() => {
        if (!input.enabled) return;
        if (restoredScopeKeyRef.current === scopeKey) return;
        restoredScopeKeyRef.current = scopeKey;

        if ((routeParamSyncEnabled && input.urlState) || !storedState) {
            return;
        }

        if (currentHistoryPaneState?.urlSig === urlSig) {
            return;
        }

        if (consumeSessionPaneHistoryTraversalForCurrentLocation()) {
            return;
        }

        pendingStoredStateWriteSigRef.current = signatureFromSerialized(serializeToParamShape(storedState));
        applySessionPaneUrlState(input.pane, storedState);
    }, [currentHistoryPaneState?.urlSig, input.enabled, input.pane, input.urlState, routeParamSyncEnabled, scopeKey, storedState, urlSig]);

    React.useEffect(() => {
        if (!input.enabled) return;
        if (input.urlState) return;

        const firstWriteForScope = storedStateHydratedScopeKeyRef.current !== scopeKey;
        if (firstWriteForScope) {
            storedStateHydratedScopeKeyRef.current = scopeKey;
            if (storedState) {
                return;
            }
        }

        writeStoredSessionPaneUrlState(scopeKey, derivedState);
    }, [derivedSig, derivedState, input.enabled, input.urlState, scopeKey, storedState]);

    React.useEffect(() => {
        if (!input.enabled) return;
        const scopeChanged = prevScopeKeyRef.current !== scopeKey;
        prevScopeKeyRef.current = scopeKey;
        if (scopeChanged) {
            pendingUrlWriteRef.current = null;
            pendingPaneReconcileRef.current = null;
            pendingStoredStateWriteSigRef.current = null;
        }

        const prevUrlSig = scopeChanged ? null : prevUrlSigRef.current;
        const prevDerivedSig = scopeChanged ? null : prevDerivedSigRef.current;
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
                scheduleCurrentSessionPaneHistoryState({ scopeKey, urlSig });
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
        // Important: initial state application should be additive (open requested panes),
        // not subtractive (closing panes the URL cannot represent, e.g. `scmReview`).
        if (routeParamSyncEnabled && isFirstRun && input.urlState) {
            applySessionPaneUrlState(input.pane, input.urlState);
            pendingPaneReconcileRef.current = { targetUrlSig: urlSig };
            return;
        }

        // Browser back/forward: URL changed without us writing it.
        if (routeParamSyncEnabled && prevUrlSig !== null && urlSig !== prevUrlSig) {
            reconcileSessionPaneScopeFromUrlState(input.pane, input.urlState);
            pendingPaneReconcileRef.current = { targetUrlSig: urlSig };
            return;
        }

        if (!routeParamSyncEnabled) return;
        if (!input.setParams) return;
        if (derivedSig === urlSig) return;
        if (!canWriteSessionPaneParamsForCurrentBrowserUrl(scopeKey)) return;

        // Pane state changed (or initial empty URL): serialize state back into the URL.
        const shouldReplaceHistoryEntry = isFirstRun || pendingStoredStateWriteSigRef.current === derivedSig;
        if (shouldReplaceHistoryEntry) {
            pendingStoredStateWriteSigRef.current = null;
        } else {
            pushSessionPaneUrlParams({
                right: derivedParams.right,
                bottom: derivedParams.bottom,
                details: derivedParams.details,
                path: derivedParams.path,
                sha: derivedParams.sha,
                terminalInstanceId: derivedParams.terminalInstanceId,
            });
        }
        pendingUrlWriteRef.current = { fromSig: urlSig, toSig: derivedSig };
        input.setParams({
            right: derivedParams.right,
            bottom: derivedParams.bottom,
            details: derivedParams.details,
            path: derivedParams.path,
            sha: derivedParams.sha,
            terminalInstanceId: derivedParams.terminalInstanceId,
        });
        scheduleCurrentSessionPaneHistoryState({ scopeKey, urlSig: derivedSig });
    }, [
        derivedParams.bottom,
        derivedParams.details,
        derivedParams.path,
        derivedParams.right,
        derivedParams.sha,
        derivedParams.terminalInstanceId,
        derivedSig,
        input.enabled,
        scopeKey,
        urlSig,
        input.pane,
        routeParamSyncEnabled,
        input.setParams,
        input.urlState,
    ]);
}
