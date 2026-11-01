import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

import { subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readHomeApplicationCarrierEligibility } from '@/sync/runtime/homeCarrierPolicy';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { BrowserPreviewRefusalReasonCode } from '@/sync/domains/browser/adapters/targets/localPreview';
import { acquireNativeDirectPreviewAccess, acquireServerPreviewAccess, hasNativePreviewRenderer, type NativeDirectPreviewLease, type ServerPreviewAccessResult } from './nativeDirectAccess';
import { PREVIEW_ADMISSION_QUERY, withoutPreviewAdmission } from './url';

export type NativeDirectPreviewInput = Readonly<{
    previewId: string | null;
    machineId: string | null;
    serverId?: string | null;
    enabled: boolean;
    /** Only actual registration metadata permits the Browser host's device-local lease path. */
    nativeDirectEnabled?: boolean;
    fallbackUrl: string | null;
    requestedUrl?: string | null;
    initialPath?: string;
    /** A real reload retries server admission without replacing a retained native lease. */
    reloadCommandId?: string;
    /** A fresh explicit registration may recover a failed view, including a refused iframe. */
    viewFailed?: boolean;
}>;

const subscribeCarrierEligibility = (notify: () => void) => subscribeRegisteredStorageState(notify) ?? (() => undefined);

type LeaseState = Readonly<{ key: string; lease: NativeDirectPreviewLease | null; settled: boolean }>;
type PreviousOrigin = Readonly<{ key: string; origin: string; initialPath: string }>;
type FallbackState = Readonly<{ key: string; result: ServerPreviewAccessResult | null }>;

function readUrl(value: string | null | undefined, base?: string): URL | null {
    if (!value) return null;
    try { return new URL(value, base); } catch { return null; }
}

function rebaseUrl(url: URL, origin: string): string {
    const rebased = new URL(origin);
    rebased.pathname = url.pathname;
    rebased.search = url.search;
    rebased.hash = url.hash;
    // Server preview admission is a one-use server-only capability, not an app parameter.
    return withoutPreviewAdmission(rebased.toString());
}

function withServerAdmission(url: string, fallback: URL): string {
    const token = fallback.searchParams.get(PREVIEW_ADMISSION_QUERY);
    if (!token) return url;
    const admitted = new URL(url);
    admitted.searchParams.set(PREVIEW_ADMISSION_QUERY, token);
    return admitted.toString();
}

function resolveViewerUrl(input: NativeDirectPreviewInput, lease: NativeDirectPreviewLease | null, previous: PreviousOrigin | null): string | null {
    const fallback = readUrl(input.fallbackUrl);
    const requested = readUrl(input.requestedUrl, lease?.localOrigin ?? fallback?.origin);
    if (lease) {
        const initial = rebaseUrl(new URL(lease.localOrigin + lease.initialPath), lease.localOrigin);
        if (!input.requestedUrl || input.requestedUrl === input.fallbackUrl) return initial;
        if (!requested) return initial;
        if (requested.origin === fallback?.origin || requested.origin === lease.localOrigin || requested.origin === previous?.origin) {
            return rebaseUrl(requested, lease.localOrigin);
        }
        // A listener from another view lifetime is not an external navigation.
        return isLoopbackHostname(requested.hostname) ? initial : input.requestedUrl;
    }
    if (fallback && requested?.origin === fallback.origin) return withServerAdmission(requested.toString(), fallback);
    if (requested && isLoopbackHostname(requested.hostname)) {
        if (!fallback) return null;
        const url = requested.origin === previous?.origin
            ? rebaseUrl(requested, fallback.origin)
            : new URL(fallback.origin + (previous?.initialPath ?? input.initialPath ?? '/')).toString();
        return withServerAdmission(url, fallback);
    }
    return requested?.toString() ?? input.fallbackUrl;
}

export function useNativeDirectPreview(input: NativeDirectPreviewInput): Readonly<{
    url: string | null;
    localOrigin: string | null;
    acquiring: boolean;
    reasonCode: BrowserPreviewRefusalReasonCode | null;
}> {
    const eligibility = useSyncExternalStore(subscribeCarrierEligibility, readHomeApplicationCarrierEligibility, readHomeApplicationCarrierEligibility);
    const runtimeActive = useSyncExternalStore(subscribeToRuntimeActiveChange, isRuntimeActive, isRuntimeActive);
    const { previewId, machineId, serverId } = input;
    const key = JSON.stringify([previewId, machineId, serverId ?? null]);
    // Like the frame's navigation key, the last reload identity survives later non-reload
    // commands. Dropping a transient command prop must not request another admission.
    const reloadCommandIdRef = useRef(input.reloadCommandId);
    if (input.reloadCommandId !== undefined) reloadCommandIdRef.current = input.reloadCommandId;
    const registrationUrlRef = useRef(input.fallbackUrl);
    const failedRegistrationUrlRef = useRef<string | null>(null);
    if (registrationUrlRef.current !== input.fallbackUrl) {
        registrationUrlRef.current = input.fallbackUrl;
        // The registration owner mints a fresh URL only on explicit Open, never on snapshots.
        // Failure alone cannot retry; a healthy viewer keeps its admitted document and lease.
        if (input.viewFailed) failedRegistrationUrlRef.current = input.fallbackUrl;
    }
    const fallbackKey = JSON.stringify([key, reloadCommandIdRef.current ?? null, failedRegistrationUrlRef.current]);
    const active = input.enabled && Boolean(previewId && machineId) && runtimeActive;
    const allowed = active && input.nativeDirectEnabled !== false && hasNativePreviewRenderer() && eligibility !== 'standard_only';
    const [state, setState] = useState<LeaseState | null>(null);
    const [fallbackState, setFallbackState] = useState<FallbackState | null>(null);
    const previous = useRef<PreviousOrigin | null>(null);
    const scope = useRef<Readonly<{ key: string; value: ServerAccountScope }> | null>(null);

    useEffect(() => {
        if (!allowed || !previewId || !machineId) {
            setState(null);
            return;
        }
        const controller = new AbortController();
        let cancelled = false;
        let owned: NativeDirectPreviewLease | null = null;
        setState({ key, lease: null, settled: false });
        void acquireNativeDirectPreviewAccess({
            previewId, machineId, serverId, signal: controller.signal,
            scope: scope.current?.key === key ? scope.current.value : undefined,
            onScopeCaptured: (value) => { if (!cancelled) scope.current = { key, value }; },
        }).then((lease) => {
            if (cancelled) {
                void lease?.release().catch(() => undefined);
                return;
            }
            owned = lease;
            setState({ key, lease, settled: true });
            if (lease) {
                const retire = () => {
                    if (cancelled || owned !== lease) return;
                    previous.current = { key, origin: lease.localOrigin, initialPath: lease.initialPath };
                    owned = null;
                    setState((current) => current?.key === key && current.lease === lease
                        ? { key, lease: null, settled: true } : current);
                    void lease.release().catch(() => undefined);
                };
                void lease.closed.then(retire, retire);
            }
        });
        return () => {
            cancelled = true;
            controller.abort();
            if (owned) previous.current = { key, origin: owned.localOrigin, initialPath: owned.initialPath };
            void owned?.release().catch(() => undefined);
        };
    }, [allowed, key, previewId, machineId, serverId]);

    const current = allowed && state?.key === key ? state : null;
    const lease = current?.lease ?? null;
    const prior = previous.current?.key === key ? previous.current : null;
    const requested = readUrl(input.requestedUrl, lease?.localOrigin ?? readUrl(input.fallbackUrl)?.origin);
    const externalNavigation = Boolean(requested && !isLoopbackHostname(requested.hostname)
        && requested.origin !== readUrl(input.fallbackUrl)?.origin
        && requested.origin !== lease?.localOrigin && requested.origin !== prior?.origin);
    const nativePending = allowed && !current?.settled;
    const needsFallback = active && !lease && !nativePending && !externalNavigation;

    useEffect(() => {
        if (!needsFallback || !previewId || !machineId) {
            setFallbackState(null);
            return;
        }
        const controller = new AbortController();
        let cancelled = false;
        setFallbackState({ key: fallbackKey, result: null });
        void acquireServerPreviewAccess({
            previewId, machineId, serverId, signal: controller.signal,
            scope: scope.current?.key === key ? scope.current.value : undefined,
            onScopeCaptured: (value) => { if (!cancelled) scope.current = { key, value }; },
        }).then((result) => {
            if (!cancelled) setFallbackState({ key: fallbackKey, result });
        });
        return () => { cancelled = true; controller.abort(); };
    }, [needsFallback, key, fallbackKey, previewId, machineId, serverId]);

    const fallback = needsFallback && fallbackState?.key === fallbackKey ? fallbackState : null;
    const fallbackPending = needsFallback && !fallback?.result;
    const serverAccess = fallback?.result;
    return {
        url: needsFallback
            ? serverAccess?.ok ? resolveViewerUrl({ ...input, fallbackUrl: serverAccess.url }, null, prior) : null
            : resolveViewerUrl(input, lease, prior),
        localOrigin: lease?.localOrigin ?? null,
        acquiring: nativePending || fallbackPending,
        reasonCode: serverAccess && !serverAccess.ok ? serverAccess.reasonCode : null,
    };
}
