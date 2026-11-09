import { createSessionProviderPendingDrainAdapter } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { SessionProviderInputConsumerSession } from '@/agent/runtime/session/input/_types';
import type {
    ExecutionRunAdmittedPendingInputV1,
    ExecutionRunPendingInputBinding,
} from '@/api/session/client/transport/sessionClientInteractionApi';
import type { PendingClaimForegroundState } from '@/api/session/pendingQueueV2Transport';
import type {
    DurableProviderInputAcceptanceV1,
    SessionProviderInputOutcome,
    SessionProviderInputRejectedBeforeEffectReason,
} from '@/agent/runtime/session/input/providerInputOutcome';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { AgentSessionSendResult } from '@happier-dev/plugin-sdk/agents/runtime';
import { logger } from '@/ui/logger';

/**
 * The Session-client custody port for one exact Execution Run target, as returned
 * by `ApiSessionClient.bindExecutionRunPendingInput`. It is a
 * `SessionProviderInputConsumerSession` so the incumbent pending drain owner can
 * be composed unchanged for this target.
 */
export type ExecutionRunPendingInputPortLike = SessionProviderInputConsumerSession & Readonly<{
    observeProviderInputSettlement: (outcome: SessionProviderInputOutcome) => Promise<boolean>;
    readDurableProviderInputAcceptanceV1: (localId: string) => Promise<DurableProviderInputAcceptanceV1>;
    dispose: () => void;
}>;

/**
 * What this exact retained runtime did with one admitted input.
 *
 * `outcome_unknown` deliberately has no settlement: the durable row stays
 * `delivering` so the incumbent reconciliation owner classifies it, and this
 * consumer never reroutes the input to the parent Session or another Run.
 */
export type ExecutionRunRuntimeDeliveryOutcome =
    | AgentSessionSendResult
    | Readonly<{
        status: 'rejected_before_effect';
        reason: SessionProviderInputRejectedBeforeEffectReason;
        /** The runtime's actual refusal diagnostic; a refusal is never reported without one. */
        diagnostic: PluginDiagnosticData;
        retryable: boolean;
    }>
    | Readonly<{ status: 'outcome_unknown'; issue: string }>;

export type ExecutionRunPendingInputDelivery = Readonly<{
    deliver: (input: ExecutionRunAdmittedPendingInputV1) => Promise<ExecutionRunRuntimeDeliveryOutcome>;
    subscribeProviderInputOutcomes?: (handler: (outcome: SessionProviderInputOutcome) => void) => () => void;
}>;

/** Target-local activity, read from this Run's controller and never the parent Session. */
export type ExecutionRunRuntimeActivity = Readonly<{
    turnInFlight: boolean;
    supportsSteer: boolean;
}>;

export type ExecutionRunPendingInputConsumerOptions = Readonly<{
    recipient: Readonly<{ kind: 'execution_run'; runId: string }>;
    sidechainId: string;
    /** Bind through the exact parent Session client custody owner. */
    bindPendingInput: (binding: ExecutionRunPendingInputBinding) => ExecutionRunPendingInputPortLike;
    readRuntimeActivity: () => ExecutionRunRuntimeActivity;
    /** The exact current controller occurrence for this run. */
    isCurrent: () => boolean;
    getMetadataSnapshot?: () => ReturnType<ExecutionRunPendingInputBinding['getMetadataSnapshot']>;
    delivery: ExecutionRunPendingInputDelivery;
    /** The Run lifecycle owner observes a proven refusal; unknown effects never enter this path. */
    onInputRejectedBeforeEffect?: (outcome: Extract<SessionProviderInputOutcome, { kind: 'rejected_before_effect' }>) => Promise<void>;
}>;

export type ExecutionRunPendingInputConsumer = Readonly<{
    /** Wake this exact target from a pending-change hint or reconnect observation. */
    wake: () => void;
    /**
     * The durable native-acceptance anchor for one admitted input.
     *
     * Agent output produced before the user anchor commits must be held until this
     * resolves `accepted`. A resolved settlement promise alone is not that proof:
     * only the durable reader survives restart and proves explicit native settlement
     * on that exact committed row. Host admission may publish the row earlier and
     * manual handling does not establish this output anchor.
     */
    awaitAcceptedUserAnchor: (localId: string) => Promise<DurableProviderInputAcceptanceV1>;
    dispose: () => Promise<void>;
}>;

function resolveForegroundState(activity: ExecutionRunRuntimeActivity): PendingClaimForegroundState {
    if (!activity.turnInFlight) return 'ready';
    return activity.supportsSteer ? 'active_steerable' : 'active_unsteerable';
}

type AdmittedEntry = Readonly<{
    input: ExecutionRunAdmittedPendingInputV1;
    admission: PendingInputAdmission;
}>;

type PendingInputAdmission = Readonly<{
    resolve: (value: DurableProviderInputAcceptanceV1) => void;
    promise: Promise<DurableProviderInputAcceptanceV1>;
}>;

/**
 * One target-bound pending consumer for a live retained Execution Run.
 *
 * It is a lifecycle-bound composition of the existing Session custody owner and
 * the incumbent pending drain loop — not a second client, queue, or poller. It
 * claims only this exact `(sessionId, runId)` target, reads activity from this
 * Run's controller, and is disposed with the exact controller occurrence.
 */
export function createExecutionRunPendingInputConsumer(
    options: ExecutionRunPendingInputConsumerOptions,
): ExecutionRunPendingInputConsumer {
    const admitted = new Map<string, AdmittedEntry>();
    const pendingAdmissions = new Map<string, PendingInputAdmission>();
    const claimed: ExecutionRunAdmittedPendingInputV1[] = [];
    const abortController = new AbortController();
    let disposed = false;
    const wakeWaiters = new Set<() => void>();
    let pumping: Promise<void> | null = null;

    const wake = (): void => {
        for (const waiter of wakeWaiters) waiter();
    };

    const getOrCreatePendingAdmission = (localId: string): PendingInputAdmission => {
        const existing = pendingAdmissions.get(localId);
        if (existing) return existing;
        let resolve!: (value: DurableProviderInputAcceptanceV1) => void;
        const promise = new Promise<DurableProviderInputAcceptanceV1>((next) => {
            resolve = next;
        });
        const admission = Object.freeze({ resolve, promise });
        pendingAdmissions.set(localId, admission);
        return admission;
    };

    const admit = (input: ExecutionRunAdmittedPendingInputV1): boolean => {
        const localId = typeof input.localId === 'string' ? input.localId.trim() : '';
        if (localId.length === 0) return false;
        admitted.set(localId, { input, admission: getOrCreatePendingAdmission(localId) });
        claimed.push(input);
        return true;
    };

    const port = options.bindPendingInput(Object.freeze({
        recipient: options.recipient,
        sidechainId: options.sidechainId,
        isCurrent: () => !disposed && options.isCurrent(),
        foregroundState: () => resolveForegroundState(options.readRuntimeActivity()),
        getMetadataSnapshot: options.getMetadataSnapshot ?? (() => null),
        consume: admit,
        wake,
    }));

    const settleAcceptance = async (
        localId: string,
        outcome: SessionProviderInputOutcome | null,
    ): Promise<void> => {
        const entry = admitted.get(localId);
        const pendingAdmission = entry?.admission ?? pendingAdmissions.get(localId);
        try {
            if (outcome) {
                await port.observeProviderInputSettlement(outcome);
            }
            // The durable reader — not the settlement promise or transcript presence —
            // proves the native-accepted user anchor. An unavailable or unclassified row stays `unknown` so no
            // caller may read it as either outcome.
            const acceptance = await port.readDurableProviderInputAcceptanceV1(localId);
            if (pendingAdmission && acceptance !== 'unknown') {
                pendingAdmission.resolve(acceptance);
                admitted.delete(localId);
                pendingAdmissions.delete(localId);
                for (const wake of wakeWaiters) wake();
            }
        } finally {
            // Pending publication can be unavailable, but a positively observed
            // pre-effect refusal still belongs to this exact Run's lifecycle.
            if (outcome?.kind === 'rejected_before_effect' && !disposed && options.isCurrent()) {
                await options.onInputRejectedBeforeEffect?.(outcome);
            }
        }
    };

    const unsubscribeOutcomes = options.delivery.subscribeProviderInputOutcomes?.((outcome) => {
        if (disposed || !options.isCurrent() || !admitted.has(outcome.localId)) return;
        void settleAcceptance(outcome.localId, outcome).catch((error) => {
            logger.debug('[executionRunPendingInput] settlement remains unresolved', error);
        });
    });

    const deliverClaimed = async (): Promise<void> => {
        while (claimed.length > 0) {
            if (disposed || !options.isCurrent()) return;
            const input = claimed.shift()!;
            const localId = typeof input.localId === 'string' ? input.localId.trim() : '';
            if (localId.length === 0) continue;
            let outcome: ExecutionRunRuntimeDeliveryOutcome;
            try {
                outcome = await options.delivery.deliver(input);
            } catch (error) {
                // An unobserved delivery failure cannot be reported as a refusal:
                // the provider effect may already have occurred.
                logger.debug('[executionRunPendingInput] delivery threw; leaving row delivering', {
                    runId: options.recipient.runId,
                    localId,
                    error: error instanceof Error ? error.message : String(error),
                });
                await settleAcceptance(localId, null);
                continue;
            }
            // Delivery can outlive Stop or occurrence replacement. Its former
            // custody cannot settle Pending or terminalize the replacement.
            if (disposed || !options.isCurrent()) return;
            // Command admission is not provider acceptance. The native input event
            // owns settlement, including events emitted after this promise resolves.
            if (outcome.status === 'admitted') continue;
            if (outcome.status === 'rejected' || outcome.status === 'unavailable' || outcome.status === 'unsupported') {
                await settleAcceptance(localId, {
                    kind: 'rejected_before_effect', localId, userMessageSeq: null,
                    reason: 'provider_rejected_before_acceptance',
                    diagnostic: outcome.diagnostic, retryable: outcome.retryable,
                });
                continue;
            }
            if (outcome.status === 'rejected_before_effect') {
                await settleAcceptance(localId, {
                    kind: 'rejected_before_effect',
                    localId,
                    userMessageSeq: null,
                    reason: outcome.reason,
                    diagnostic: outcome.diagnostic,
                    retryable: outcome.retryable,
                });
                continue;
            }
            await settleAcceptance(localId, null);
        }
    };

    const drainAdapter = createSessionProviderPendingDrainAdapter(port, {
        afterDrain: async () => {
            await deliverClaimed();
            for (const localId of pendingAdmissions.keys()) await settleAcceptance(localId, null);
        },
        waitForInputChange: async (signal) => await new Promise<boolean>((resolve) => {
            const onWake = () => finish(true);
            const onAbort = () => finish(false);
            const finish = (changed: boolean) => {
                wakeWaiters.delete(onWake);
                signal.removeEventListener('abort', onAbort);
                resolve(changed);
            };
            wakeWaiters.add(onWake);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        }),
    });
    pumping = drainAdapter.pumpPendingWhileActive({
        abortSignal: abortController.signal,
        shouldContinue: () => !disposed && options.isCurrent(),
    }).catch((error) => {
        logger.debug('[executionRunPendingInput] target consumer stopped', {
            runId: options.recipient.runId,
            error: error instanceof Error ? error.message : String(error),
        });
    });

    return Object.freeze({
        wake: () => {
            wake();
        },
        awaitAcceptedUserAnchor: async (localId): Promise<DurableProviderInputAcceptanceV1> => {
            if (disposed || !options.isCurrent()) return 'unknown';
            const entry = admitted.get(localId);
            if (entry) return await entry.admission.promise;
            const durable = await port.readDurableProviderInputAcceptanceV1(localId);
            // Disposal can win while the exact read is pending. Never install a
            // waiter after disposal has already settled this occurrence's waiters.
            if (disposed || !options.isCurrent()) return 'unknown';
            if (durable !== 'unknown') return durable;
            // Materialization can race the durable read. Recheck the admitted map
            // before installing the event waiter so an already-claimed input can
            // never strand its observer on a different promise.
            return await (admitted.get(localId)?.admission ?? getOrCreatePendingAdmission(localId)).promise;
        },
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            unsubscribeOutcomes?.();
            abortController.abort();
            // A superseded or stopped occurrence never resolves an anchor as accepted.
            for (const admission of pendingAdmissions.values()) admission.resolve('unknown');
            pendingAdmissions.clear();
            port.dispose();
            // Revocation is synchronous with this occurrence's authority. A provider
            // delivery already in flight may never settle and must not hold stop or
            // supersession open; the pump retains its own terminal catch above.
            void pumping;
        },
    });
}
