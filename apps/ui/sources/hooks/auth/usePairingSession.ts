import * as React from 'react';
import type { StartPairingForHomeResult, StartedHomePairing, HomePairingFailureCause } from '@/auth/pairing/startPairingForHome';
import type { PairingCallTarget, PairingStatus } from '@/sync/api/account/apiPairingAuth';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type StartPairingResult = { ok: true } | { ok: false; status: number; reason?: 'invalid_invite' | 'update_required' };
type CancelPairingResult = { ok: true } | { ok: false; status: number };
export type PairingContext = Readonly<{ pairId: string; target: PairingCallTarget; issuedAtMs: number; expiresAtMs: number }>;
export type PairingCompletionState = 'idle' | 'pending' | 'adding' | 'retrying' | 'completed' | 'invalid_request' | 'completion_failed' | 'expired' | 'update_required';
export type PairingPresentation =
    | Readonly<{ phase: 'generating' }>
    | Readonly<{ phase: 'ready'; deepLink: string; context: PairingContext; qrAvailable: boolean }>
    | Readonly<{ phase: 'adding' | 'retryable_error' | 'succeeded'; context: PairingContext; requestedDeviceLabel: string | null }>
    | Readonly<{ phase: 'expired'; context: PairingContext }>
    | Readonly<{ phase: 'invalid_request'; cause?: PairingFailureCause }>
    | Readonly<{ phase: 'update_required' }>;

/**
 * Why a code could not be made, in the person's terms. Every exit of the start path names one, so the
 * panel never shows a bare "couldn't" and a report carries the cause.
 * - `home_unreachable`: the Home (or its published address) did not answer from this device.
 * - `home_identity_unverified`: this device's record of the Home and the Home's own answer disagree.
 * - `signed_out`: this device holds no sign-in for the Home.
 * - `invite_too_large`: the invite cannot fit a code (too many addresses to carry).
 * - `home_refused`: the Home turned the code down.
 * - `unexpected`: anything else.
 */
export type PairingFailureCause = HomePairingFailureCause;
type StartedLifecycle = StartedHomePairing;

/**
 * React presentation adapter over the shared client-neutral direct Home QR lifecycle.
 *
 * `targetProfileId` names the saved Home this QR enrols a device into. It defaults to
 * the focused Home; a different saved Home is paired without changing focus, and only
 * the focused Home's own runtime lease (Iroh or a leased loopback origin) can be used
 * as transport, so a background Home is reached through its published descriptor.
 */
export function usePairingSession(params: Readonly<{
    enabled: boolean;
    isAuthenticated: boolean;
    targetProfileId?: string | null;
    /** Reports the existing successful approval outcome, never pending, failure, or cancellation. */
    onCompleted?: (context: PairingContext) => void;
}>): Readonly<{
    deepLink: string | null; status: PairingStatus | null; pairingContext: PairingContext | null;
    completionState: PairingCompletionState; presentation: PairingPresentation; isExpired: boolean; isStarting: boolean;
    startPairing: () => Promise<StartPairingResult>; cancelPairing: () => Promise<CancelPairingResult>; clearSession: () => void;
}> {
    const { enabled, isAuthenticated } = params;
    const targetProfileId = params.targetProfileId?.trim() || null;
    const [status, setStatus] = React.useState<PairingStatus | null>(null);
    const [deepLink, setDeepLink] = React.useState<string | null>(null);
    const [pairingContext, setPairingContext] = React.useState<PairingContext | null>(null);
    const [completionState, setCompletionState] = React.useState<PairingCompletionState>('idle');
    const [failureCause, setFailureCause] = React.useState<PairingFailureCause | null>(null);
    const [qrAvailable, setQrAvailable] = React.useState(true);
    const [requestedDeviceLabel, setRequestedDeviceLabel] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);
    const startingAbortRef = React.useRef<AbortController | null>(null);
    const generationRef = React.useRef(0);
    const activeRef = React.useRef<Readonly<{ lifecycle: StartedLifecycle; context: PairingContext }> | null>(null);
    const completionCallbackRef = React.useRef(params.onCompleted);
    completionCallbackRef.current = params.onCompleted;

    const resetPresentation = React.useCallback((preserveContext: boolean) => {
        setStatus(null); setDeepLink(null); setQrAvailable(true);
        if (!preserveContext) { setPairingContext(null); setRequestedDeviceLabel(null); }
    }, []);
    const clearSession = React.useCallback(() => {
        generationRef.current += 1; isStartingRef.current = false;
        startingAbortRef.current?.abort(); startingAbortRef.current = null;
        const active = activeRef.current; activeRef.current = null; void active?.lifecycle.cancel();
        resetPresentation(false); setCompletionState('idle'); setFailureCause(null); setIsStarting(false);
    }, [resetPresentation]);
    React.useEffect(() => () => {
        generationRef.current += 1;
        startingAbortRef.current?.abort();
        startingAbortRef.current = null;
        const active = activeRef.current;
        activeRef.current = null;
        void active?.lifecycle.cancel();
    }, []);
    React.useEffect(() => { if (!(enabled && isAuthenticated)) clearSession(); }, [clearSession, enabled, isAuthenticated]);

    const startPairing = React.useCallback(async (): Promise<StartPairingResult> => {
        if (!enabled || !isAuthenticated) return { ok: false, status: 401 };
        if (isStartingRef.current) return { ok: false, status: 409 };
        const generation = ++generationRef.current;
        // Retain the launching consumer's Account scope without making callback identity restart a QR.
        const onCompleted = completionCallbackRef.current;
        const isCurrent = () => generationRef.current === generation;
        startingAbortRef.current?.abort();
        const startingAbort = new AbortController();
        startingAbortRef.current = startingAbort;
        const previous = activeRef.current; activeRef.current = null; await previous?.lifecycle.cancel();
        if (!isCurrent()) return { ok: false, status: 409 };
        isStartingRef.current = true; setIsStarting(true); setCompletionState('idle'); setFailureCause(null); resetPresentation(false);
        const fail = (cause: PairingFailureCause, status = 412): { ok: false; status: number } => {
            setFailureCause(cause); setCompletionState('completion_failed');
            return { ok: false, status };
        };
        try {
            let completing = false;
            const delivered: { current: StartPairingForHomeResult | null } = { current: null };
            const serverId = targetProfileId ?? getActiveServerSnapshot().serverId;
            const execute = createFrontDoorActionExecute(undefined, { homePairingDelivery: {
                isCurrent, onResult: (result) => { delivered.current = result; },
                onStatus: (status) => { if (isCurrent()) setStatus(status); },
                onCompleting: (requestedDeviceLabel) => {
                    completing = true;
                    if (isCurrent()) { setDeepLink(null); setRequestedDeviceLabel(requestedDeviceLabel); setCompletionState('adding'); }
                },
                onRetrying: () => { if (isCurrent()) setCompletionState('retrying'); },
            } });
            const execution = await execute('machines.pairing.create', { serverId }, {
                surface: 'ui', serverId, signal: startingAbort.signal,
            });
            const started = delivered.current;
            if (!isCurrent()) { if (started?.kind === 'started') await started.cancel(); return { ok: false, status: 409 }; }
            if (!execution.ok && started?.kind === 'started') {
                await started.cancel();
                return fail('home_refused', 403);
            }
            if (!started) return fail('home_refused', 403);
            if (started.kind === 'update_required') { setCompletionState('update_required'); return { ok: false, status: 426, reason: 'update_required' }; }
            if (started.kind === 'failed') {
                fail(started.cause, started.status);
                return { ok: false, status: started.status, ...(started.reason === 'invalid_invite' ? { reason: 'invalid_invite' as const } : {}) };
            }
            if (started.kind !== 'started') return { ok: false, status: 409 };
            const context = { pairId: started.invite.pairId, target: started.target, issuedAtMs: started.invite.issuedAtMs, expiresAtMs: started.invite.expiresAtMs };
            activeRef.current = { lifecycle: started, context };
            setPairingContext(context); setQrAvailable(started.qrAvailable);
            if (!completing) {
                setDeepLink(started.link);
                setStatus({ state: 'pending', pairId: context.pairId, expiresAt: new Date(context.expiresAtMs).toISOString() }); setCompletionState('pending');
            }
            void started.completion.then((outcome) => {
                if (!isCurrent() || activeRef.current?.lifecycle !== started) return;
                activeRef.current = null;
                if (outcome.kind === 'completed') {
                    setRequestedDeviceLabel(outcome.requestedDeviceLabel); setCompletionState('completed');
                    onCompleted?.(context);
                }
                else if (outcome.kind === 'expired') { resetPresentation(true); setCompletionState('expired'); }
                else if (outcome.kind === 'invalid_request') { resetPresentation(false); setFailureCause('home_refused'); setCompletionState('invalid_request'); }
                else if (outcome.kind === 'failed') { resetPresentation(false); setFailureCause('home_refused'); setCompletionState('completion_failed'); }
            });
            return { ok: true };
        } catch (error) {
            if (!isCurrent()) return { ok: false, status: 409 };
            if (error instanceof Error && 'code' in error && error.code === 'action_home_signed_out') return fail('signed_out');
            return fail('unexpected', 500);
        }
        finally {
            if (startingAbortRef.current === startingAbort) startingAbortRef.current = null;
            if (isCurrent()) { isStartingRef.current = false; setIsStarting(false); }
        }
    }, [enabled, isAuthenticated, resetPresentation, targetProfileId]);

    const cancelPairing = React.useCallback(async (): Promise<CancelPairingResult> => {
        const active = activeRef.current;
        if (!active || completionState !== 'pending') return { ok: false, status: 409 };
        const result = await active.lifecycle.cancel();
        if (!result.ok) return { ok: false, status: 500 };
        if (result.outcome === 'cancelled') clearSession();
        return { ok: true };
    }, [clearSession, completionState]);

    const presentation = React.useMemo<PairingPresentation>(() => {
        if (completionState === 'expired' && pairingContext) return { phase: 'expired', context: pairingContext };
        if (completionState === 'update_required') return { phase: 'update_required' };
        if (completionState === 'invalid_request' || completionState === 'completion_failed') {
            return failureCause ? { phase: 'invalid_request', cause: failureCause } : { phase: 'invalid_request' };
        }
        if (pairingContext) {
            if (completionState === 'adding') return { phase: 'adding', context: pairingContext, requestedDeviceLabel };
            if (completionState === 'retrying') return { phase: 'retryable_error', context: pairingContext, requestedDeviceLabel };
            if (completionState === 'completed') return { phase: 'succeeded', context: pairingContext, requestedDeviceLabel };
            if (completionState === 'pending' && deepLink) return { phase: 'ready', deepLink, context: pairingContext, qrAvailable };
        }
        return { phase: 'generating' };
    }, [completionState, deepLink, failureCause, pairingContext, qrAvailable, requestedDeviceLabel]);
    return { deepLink, status, pairingContext, completionState, presentation, isExpired: completionState === 'expired', isStarting, startPairing, cancelPairing, clearSession };
}
