import { createCoalescedScheduler, type CoalescedScheduler } from '@happier-dev/plugin-sdk/async';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import {
    evaluateRefreshEligibility,
    recordRefreshFailure,
    TRIAGE_REFRESH_BACKOFF_IDLE_V1,
    type TriageRefreshBackoffStateV1,
    type TriageRefreshPacingReasonV1,
    type TriageRefreshTriggerV1,
} from './refreshEligibility.js';

/**
 * The one process-local in-flight owner for Triage provider refresh.
 *
 * Provider-derived Triage data is not an Account-persisted corpus: rich detail
 * and mutations always require a live source materialization. So the only thing
 * that needs coordinating is *provider work* — one live pass per configured
 * source instance at a time, paced so an interaction burst cannot multiply into
 * provider calls.
 *
 * This owner is deliberately thin. Single-flight with at most one queued
 * follow-up is the SDK's `createCoalescedScheduler`, unchanged. Pacing is
 * `refreshEligibility`. Presentation continuity — last-known-good retention,
 * stale-while-revalidate, and a refresh failure never erasing an admitted value
 * — belongs to the mounted Plugin UI Resource store (`usePluginResource` /
 * `useLivePluginResource`) on the client side of the host boundary, and is not
 * reimplemented here.
 *
 * What is genuinely Triage's own: keying by configured source instance, the
 * producer vocabulary, and the rule that only manual **Refresh** may queue a
 * follow-up while a pass is running.
 *
 * Nothing here survives the process. There is no durable scan state, no
 * continuation custody, no checkpoint, and no cross-machine coordination: two
 * machines may legitimately refresh the same configured source, because each
 * asks its own daemon for its own live materialization.
 */

/** What one pass is given. Deliberately not a checkpoint, cursor, or resume token. */
export type TriageRefreshPassInputV1 = Readonly<{
    sourceInstanceId: string;
    /** Canonical cancellation for retirement, reconfiguration, or shutdown. */
    signal: AbortSignal;
}>;

/**
 * How one pass ended.
 *
 * `interrupted` is the honest third arm: an aborted, deadline-stopped, or
 * currentness-rejected walk is neither a completed walk (which would clear
 * backoff) nor provider evidence about the source (which would create one).
 */
export type TriageRefreshPassOutcomeV1 =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'interrupted' }>
    | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

/** Why a request did not read the provider now. */
export type TriageRefreshBlockedV1 =
    | Readonly<{ reason: 'retired' }>
    | Readonly<{ reason: TriageRefreshPacingReasonV1; nextEligibleAtMs: number }>;

export type TriageRefreshRequestResultV1 = Readonly<{
    /**
     * `joined` attaches to the running pass; `followUpQueued` records the one
     * manual follow-up. A caller that stops awaiting `settled` detaches itself
     * and never cancels work another caller is still waiting on — there is
     * deliberately no per-caller abort.
     */
    disposition: 'started' | 'joined' | 'followUpQueued' | 'blocked';
    /** Settles when the pass this request attached to reaches idle. */
    settled: Promise<void>;
    blocked?: TriageRefreshBlockedV1;
}>;

export type TriageRefreshCoordinatorV1 = Readonly<{
    request(input: Readonly<{
        sourceInstanceId: string;
        trigger: TriageRefreshTriggerV1;
    }>): TriageRefreshRequestResultV1;
    /** Retirement, reconfiguration, or contribution loss for one instance. */
    retire(sourceInstanceId: string): void;
    dispose(): void;
}>;

type RefreshSlot = {
    readonly sourceInstanceId: string;
    readonly scheduler: CoalescedScheduler;
    /** Non-null exactly while a provider pass is running. */
    activePass: Promise<void> | null;
    abortController: AbortController | null;
    /** The trigger the next pass is running for; re-evaluated at pass start. */
    pendingTrigger: TriageRefreshTriggerV1;
    lastReadStartedAtMs: number | null;
    backoff: TriageRefreshBackoffStateV1;
    retired: boolean;
};

export function createTriageRefreshCoordinator(deps: Readonly<{
    /**
     * Runs one live source materialization for one configured instance. It
     * owns paging, mapping, and its own deadlines; it must resolve with an
     * outcome rather than reject.
     */
    runPass: (input: TriageRefreshPassInputV1) => Promise<TriageRefreshPassOutcomeV1>;
    nowMs: () => number;
    random?: () => number;
    /**
     * A rejected pass is a defect in the pass runner, not provider evidence.
     * It is reported here and then treated exactly like an interruption.
     */
    onUnexpectedError?: (error: unknown) => void;
}>): TriageRefreshCoordinatorV1 {
    const random = deps.random ?? Math.random;
    const slots = new Map<string, RefreshSlot>();
    let disposed = false;

    async function executePass(slot: RefreshSlot): Promise<void> {
        const controller = new AbortController();
        slot.abortController = controller;
        // Measured from the read start, so a slow pass cannot turn the minimum
        // interval into "one pass duration plus one interval".
        slot.lastReadStartedAtMs = deps.nowMs();
        let outcome: TriageRefreshPassOutcomeV1;
        try {
            outcome = await deps.runPass({
                sourceInstanceId: slot.sourceInstanceId,
                signal: controller.signal,
            });
        } catch (error) {
            deps.onUnexpectedError?.(error);
            outcome = { kind: 'interrupted' };
        } finally {
            if (slot.abortController === controller) slot.abortController = null;
        }
        // A retired instance's late result cannot write pacing state for an
        // instance that no longer exists.
        if (slot.retired) return;
        if (outcome.kind === 'completed') {
            slot.backoff = TRIAGE_REFRESH_BACKOFF_IDLE_V1;
            return;
        }
        if (outcome.kind === 'failed') {
            slot.backoff = recordRefreshFailure({
                backoff: slot.backoff,
                failure: outcome.failure,
                nowMs: deps.nowMs(),
                random,
            });
        }
    }

    function drainSlot(slot: RefreshSlot): Promise<void> {
        if (slot.retired || disposed) return Promise.resolve();
        // The queued follow-up runs after the failure that may have created a
        // deadline, so pacing is decided at pass start, not only at request
        // time. Both decisions come from the one evaluator.
        const eligibility = evaluateRefreshEligibility({
            trigger: slot.pendingTrigger,
            nowMs: deps.nowMs(),
            lastReadStartedAtMs: slot.lastReadStartedAtMs,
            backoff: slot.backoff,
        });
        if (eligibility.kind === 'blocked') return Promise.resolve();
        const pass = executePass(slot);
        slot.activePass = pass;
        return pass.finally(() => {
            if (slot.activePass === pass) slot.activePass = null;
        });
    }

    function openSlot(sourceInstanceId: string, trigger: TriageRefreshTriggerV1): RefreshSlot {
        const existing = slots.get(sourceInstanceId);
        if (existing) {
            existing.pendingTrigger = trigger;
            return existing;
        }
        const slot: RefreshSlot = {
            sourceInstanceId,
            // The scheduler drains this exact slot; `drain` runs only after the
            // slot exists, so the self-reference is resolved by then.
            scheduler: createCoalescedScheduler({
                drain: () => drainSlot(slot),
                ...(deps.onUnexpectedError ? { onError: deps.onUnexpectedError } : {}),
            }),
            activePass: null,
            abortController: null,
            pendingTrigger: trigger,
            lastReadStartedAtMs: null,
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            retired: false,
        };
        slots.set(sourceInstanceId, slot);
        return slot;
    }

    function closeSlot(slot: RefreshSlot): void {
        slot.retired = true;
        slot.abortController?.abort();
        slot.abortController = null;
        slot.scheduler.dispose();
        slots.delete(slot.sourceInstanceId);
    }

    return Object.freeze({
        request(input): TriageRefreshRequestResultV1 {
            if (disposed) {
                return {
                    disposition: 'blocked',
                    settled: Promise.resolve(),
                    blocked: { reason: 'retired' },
                };
            }
            const existing = slots.get(input.sourceInstanceId);
            if (existing?.activePass) {
                // Only the user's explicit Refresh earns a follow-up pass. View
                // demand during an active pass is already being served by it.
                if (input.trigger !== 'manual') {
                    return { disposition: 'joined', settled: existing.activePass };
                }
                existing.pendingTrigger = 'manual';
                return { disposition: 'followUpQueued', settled: existing.scheduler.flush() };
            }
            const eligibility = evaluateRefreshEligibility({
                trigger: input.trigger,
                nowMs: deps.nowMs(),
                lastReadStartedAtMs: existing?.lastReadStartedAtMs ?? null,
                backoff: existing?.backoff ?? TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            });
            if (eligibility.kind === 'blocked') {
                return {
                    disposition: 'blocked',
                    settled: Promise.resolve(),
                    blocked: {
                        reason: eligibility.reason,
                        nextEligibleAtMs: eligibility.nextEligibleAtMs,
                    },
                };
            }
            const slot = openSlot(input.sourceInstanceId, input.trigger);
            return { disposition: 'started', settled: slot.scheduler.flush() };
        },
        retire(sourceInstanceId: string): void {
            const slot = slots.get(sourceInstanceId);
            if (slot) closeSlot(slot);
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const slot of [...slots.values()]) closeSlot(slot);
        },
    } satisfies TriageRefreshCoordinatorV1);
}
