import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import {
    evaluateRefreshEligibility,
    type TriageRefreshPacingBlockV1,
    type TriageRefreshTriggerV1,
} from './refreshEligibility.js';

/**
 * The one process-local in-flight owner for Triage provider refresh.
 *
 * Provider-derived Triage data is not an Account-persisted corpus: rich detail
 * and mutations always require a live source materialization. So the only thing
 * that needs coordinating is *provider work* — each configured source instance
 * honoring each configured source instance's own retry deadline.
 *
 * This owner is deliberately thin. Pacing is `refreshEligibility`. Presentation
 * continuity — last-known-good retention, stale-while-revalidate, and a refresh
 * failure never erasing an admitted value — belongs to the mounted Plugin UI
 * Resource store (`usePluginResource` / `useLivePluginResource`) on the client
 * side of the host boundary, and is not reimplemented here.
 *
 * Single-flight is *not* owned here either, and deliberately no longer
 * reimplemented here. The one producer of `request` is the list-window store's
 * refresh cycle, which is itself the `drain` of the store's
 * `createCoalescedScheduler`: that scheduler already collapses an interaction
 * burst into one cycle and never overlaps a cycle with itself, and the
 * coordinator is created and disposed with that one store, so no second
 * producer can contend for a slot. A second per-source scheduler underneath it
 * could only ever coalesce a request that the cycle above had already
 * coalesced. What would invalidate this: a second caller of `request` for the
 * same coordinator — then single-flight belongs at that new producer's own
 * choke point, not as a duplicate scheduler here.
 *
 * What is genuinely Triage's own: keying by configured source instance and the
 * producer vocabulary.
 *
 * Nothing here survives the process. There is no durable scan state, no
 * continuation custody, no checkpoint, and no cross-machine coordination: two
 * machines may legitimately refresh the same configured source, because each
 * asks its own daemon for its own live materialization.
 */

/** What one pass is given. Deliberately not a checkpoint, cursor, or resume token. */
export type TriageRefreshPassInputV1 = Readonly<{
    sourceInstanceIds: readonly string[];
    /** Canonical caller cancellation when the store is disposed or shuts down. */
    signal: AbortSignal;
}>;

/**
 * How one pass ended.
 *
 * `interrupted` is the honest third arm: an aborted walk is neither a completed
 * walk (which clears the retry deadline) nor new provider failure evidence.
 */
export type TriageRefreshPassOutcomeV1 =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'interrupted' }>
    | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

/** Why a request did not read the provider now. */
export type TriageRefreshBlockedV1 =
    | Readonly<{ reason: 'retired' }>
    | TriageRefreshPacingBlockV1;

/** Whether a refusal carries a deadline a surface can state, or is a dead slot. */
export function triageRefreshPacingBlock(
    blocked: TriageRefreshBlockedV1 | undefined,
): TriageRefreshPacingBlockV1 | null {
    return blocked === undefined || blocked.reason === 'retired' ? null : blocked;
}

export type TriageRefreshRequestResultV1 = Readonly<{
    /** Whether this request read the provider at all. */
    disposition: 'started' | 'blocked';
    /**
     * Settles when the pass this request started reaches idle, immediately when
     * it was refused. A caller that stops awaiting it detaches itself and never
     * cancels the work — there is deliberately no per-caller abort. A pass
     * runner that rejects is reported through `onUnexpectedError` and folded
     * into an `interrupted` outcome rather than rejecting this promise.
     */
    settled: Promise<void>;
    startedSourceInstanceIds: readonly string[];
    blocked: readonly Readonly<{
        sourceInstanceId: string;
        reason: TriageRefreshBlockedV1;
    }>[];
}>;

export type TriageRefreshCoordinatorV1 = Readonly<{
    request(input: Readonly<{
        sourceInstanceIds: readonly string[];
        trigger: TriageRefreshTriggerV1;
        /** Ordered merges need a head from every requested source. */
        requireAllSources?: boolean;
    }>): TriageRefreshRequestResultV1;
    /**
     * What this trigger would be told right now, without asking for a pass.
     *
     * A surface that offers **Refresh** has to know whether pressing it can read
     * anything, and it must learn that from the same evaluator the request itself
     * uses — otherwise the control and the coordinator answer one question twice.
     * It is a pure read of process-local pacing state: it starts nothing, records
     * nothing, and opens no slot.
     */
    pacingBlock(input: Readonly<({ sourceInstanceId: string } | { sourceInstanceIds: readonly string[]; requireAllSources: true }) & {
        trigger: TriageRefreshTriggerV1;
    }>): TriageRefreshPacingBlockV1 | null;
    /** Retirement, reconfiguration, or contribution loss for one instance. */
    retire(sourceInstanceId: string): void;
    /** Superseded acquisition: abort active reads, preserving provider pacing. */
    cancel(): void;
    dispose(): void;
}>;

/** Process-local pacing state for one configured source instance. */
type RefreshSlot = {
    readonly sourceInstanceId: string;
    retryNotBeforeMs: number | null;
    retired: boolean;
};

export function createTriageRefreshCoordinator(deps: Readonly<{
    /**
     * Runs one live materialization for the eligible configured-source set. It
     * owns paging and mapping, follows the caller lifetime, and returns one outcome per
     * source rather than rejecting.
     */
    runPass: (input: TriageRefreshPassInputV1) => Promise<readonly Readonly<{
        sourceInstanceId: string;
        outcome: TriageRefreshPassOutcomeV1;
    }>[] >;
    nowMs: () => number;
    /**
     * A rejected pass is a defect in the pass runner, not provider evidence.
     * It is reported here and then treated exactly like an interruption.
     */
    onUnexpectedError?: (error: unknown) => void;
}>): TriageRefreshCoordinatorV1 {
    const slots = new Map<string, RefreshSlot>();
    const activePasses = new Set<AbortController>();
    let disposed = false;

    async function executePass(activeSlots: readonly RefreshSlot[]): Promise<void> {
        const controller = new AbortController();
        activePasses.add(controller);
        let outcomes: readonly Readonly<{
            sourceInstanceId: string;
            outcome: TriageRefreshPassOutcomeV1;
        }>[];
        try {
            outcomes = await deps.runPass({
                sourceInstanceIds: activeSlots.map((slot) => slot.sourceInstanceId),
                signal: controller.signal,
            });
        } catch (error) {
            deps.onUnexpectedError?.(error);
            outcomes = [];
        } finally {
            activePasses.delete(controller);
        }
        if (controller.signal.aborted) return;
        const bySource = new Map(outcomes.map((entry) => [entry.sourceInstanceId, entry.outcome]));
        for (const slot of activeSlots) {
            // A retired instance's late result cannot write pacing state for an
            // instance that no longer exists.
            if (slot.retired) continue;
            const outcome = bySource.get(slot.sourceInstanceId) ?? { kind: 'interrupted' as const };
            if (outcome.kind === 'completed') {
                slot.retryNotBeforeMs = null;
                continue;
            }
            if (outcome.kind === 'failed') {
                slot.retryNotBeforeMs = outcome.failure.retryNotBeforeMs ?? null;
            }
        }
    }

    function openSlot(sourceInstanceId: string): RefreshSlot {
        const existing = slots.get(sourceInstanceId);
        if (existing) return existing;
        const slot: RefreshSlot = {
            sourceInstanceId,
            retryNotBeforeMs: null,
            retired: false,
        };
        slots.set(sourceInstanceId, slot);
        return slot;
    }

    function closeSlot(slot: RefreshSlot): void {
        slot.retired = true;
        slots.delete(slot.sourceInstanceId);
    }

    function eligibleSources(sourceInstanceIds: readonly string[], requireAllSources = false): Readonly<{
        eligible: readonly string[];
        blocked: TriageRefreshRequestResultV1['blocked'];
    }> {
        const blocked: Array<{ sourceInstanceId: string; reason: TriageRefreshPacingBlockV1 }> = [];
        const eligible: string[] = [];
        for (const sourceInstanceId of sourceInstanceIds) {
            const eligibility = evaluateRefreshEligibility({ nowMs: deps.nowMs(),
                retryNotBeforeMs: slots.get(sourceInstanceId)?.retryNotBeforeMs ?? null });
            if (eligibility.kind === 'blocked') blocked.push({ sourceInstanceId, reason: {
                reason: eligibility.reason, nextEligibleAtMs: eligibility.nextEligibleAtMs,
            } });
            else eligible.push(sourceInstanceId);
        }
        if (requireAllSources && blocked.length > 0) {
            const latest = blocked.reduce((left, right) => left.reason.nextEligibleAtMs >= right.reason.nextEligibleAtMs ? left : right);
            return { eligible: [], blocked: sourceInstanceIds.map(sourceInstanceId => ({ sourceInstanceId, reason: latest.reason })) };
        }
        return { eligible, blocked };
    }

    return Object.freeze({
        request(input): TriageRefreshRequestResultV1 {
            if (disposed) {
                return {
                    disposition: 'blocked',
                    settled: Promise.resolve(),
                    startedSourceInstanceIds: [],
                    blocked: input.sourceInstanceIds.map((sourceInstanceId) => ({
                        sourceInstanceId,
                        reason: { reason: 'retired' },
                    })),
                };
            }
            const eligibility = eligibleSources(input.sourceInstanceIds, input.requireAllSources);
            const activeSlots = eligibility.eligible.map(openSlot);
            const blocked = eligibility.blocked;
            const startedSourceInstanceIds = activeSlots.map((slot) => slot.sourceInstanceId);
            return {
                disposition: activeSlots.length === 0 ? 'blocked' : 'started',
                settled: activeSlots.length === 0 ? Promise.resolve() : executePass(activeSlots),
                startedSourceInstanceIds,
                blocked,
            };
        },
        pacingBlock(input): TriageRefreshPacingBlockV1 | null {
            if (disposed) return null;
            const sourceInstanceIds = 'sourceInstanceId' in input ? [input.sourceInstanceId] : input.sourceInstanceIds;
            const eligibility = eligibleSources(sourceInstanceIds, 'sourceInstanceIds' in input);
            return triageRefreshPacingBlock(eligibility.blocked[0]?.reason);
        },
        retire(sourceInstanceId: string): void {
            const slot = slots.get(sourceInstanceId);
            if (slot) closeSlot(slot);
        },
        cancel(): void {
            for (const controller of activePasses) controller.abort();
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const controller of activePasses) controller.abort();
            for (const slot of [...slots.values()]) closeSlot(slot);
        },
    } satisfies TriageRefreshCoordinatorV1);
}
