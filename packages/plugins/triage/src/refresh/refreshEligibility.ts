/** Named process-local refresh demand; neither trigger bypasses provider authority. */
export type TriageRefreshTriggerV1 = 'view' | 'manual';

/** The source's own retry deadline is the only pacing authority. */
export type TriageRefreshPacingReasonV1 = 'sourceRetryDeadline';

/** Published by the coordinator so every surface explains the same wait. */
export type TriageRefreshPacingBlockV1 = Readonly<{
    reason: TriageRefreshPacingReasonV1;
    nextEligibleAtMs: number;
}>;

export function isTriageRefreshPacingBlockActiveV1(
    block: TriageRefreshPacingBlockV1 | null | undefined,
    nowMs: number,
): block is TriageRefreshPacingBlockV1 {
    return block !== null && block !== undefined && block.nextEligibleAtMs > nowMs;
}

export type TriageRefreshEligibilityV1 =
    | Readonly<{ kind: 'eligible' }>
    | (Readonly<{ kind: 'blocked' }> & TriageRefreshPacingBlockV1);

/** Read only on demand: preserve the provider's absolute deadline without a local cadence. */
export function evaluateRefreshEligibility(input: Readonly<{
    nowMs: number;
    retryNotBeforeMs: number | null;
}>): TriageRefreshEligibilityV1 {
    return input.retryNotBeforeMs === null || input.retryNotBeforeMs <= input.nowMs
        ? { kind: 'eligible' }
        : { kind: 'blocked', reason: 'sourceRetryDeadline', nextEligibleAtMs: input.retryNotBeforeMs };
}
