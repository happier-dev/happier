export type JsonlFollowPolicyV1 = Readonly<{
    activeBurstPollIntervalMs: number;
    activeBurstDurationMs: number;
    activeFallbackPollIntervalMs: number;
    idleFallbackPollIntervalMs: number;
    missingFileRetryIntervalMs: number;
    sidechainCompletionGraceMs: number;
    maxActiveFollowersPerSession: number;
    maxIdleFollowersPerSession: number;
    maxClosedFollowerRecordsPerSession: number;
    maxBufferedSidechainRows: number;
    maxBufferedSidechainBytes: number;
    maxDrainRowsPerTick: number;
    maxDrainBytesPerTick: number;
}>;

export type JsonlFollowPolicy = JsonlFollowPolicyV1;

export type JsonlFollowPolicyInputV1 = Partial<JsonlFollowPolicyV1>;

export type JsonlFollowPolicyInput = JsonlFollowPolicyInputV1;

export type JsonlFollowPollStateV1 = Readonly<{
    nowMs: number;
    lastActivityAtMs: number | null;
    idle: boolean;
    missingFile: boolean;
}>;

export type JsonlFollowPollState = JsonlFollowPollStateV1;

export const DEFAULT_JSONL_FOLLOW_POLICY: JsonlFollowPolicyV1 = Object.freeze({
    activeBurstPollIntervalMs: 250,
    activeBurstDurationMs: 5_000,
    activeFallbackPollIntervalMs: 1_000,
    idleFallbackPollIntervalMs: 5_000,
    missingFileRetryIntervalMs: 1_000,
    sidechainCompletionGraceMs: 2_000,
    maxActiveFollowersPerSession: 64,
    maxIdleFollowersPerSession: 128,
    maxClosedFollowerRecordsPerSession: 256,
    maxBufferedSidechainRows: 1_000,
    maxBufferedSidechainBytes: 1_048_576,
    maxDrainRowsPerTick: 1_000,
    maxDrainBytesPerTick: 262_144,
});

export function normalizeJsonlFollowPolicy(
    input?: JsonlFollowPolicyInputV1,
    legacyPollIntervalMs?: number,
): JsonlFollowPolicyV1 {
    const legacyInterval = normalizePositiveInteger(legacyPollIntervalMs, DEFAULT_JSONL_FOLLOW_POLICY.activeBurstPollIntervalMs);
    const activeBurstPollIntervalMs = normalizePositiveInteger(input?.activeBurstPollIntervalMs, legacyInterval);
    const activeFallbackPollIntervalMs = normalizePositiveInteger(
        input?.activeFallbackPollIntervalMs,
        DEFAULT_JSONL_FOLLOW_POLICY.activeFallbackPollIntervalMs,
    );
    return {
        activeBurstPollIntervalMs,
        activeBurstDurationMs: normalizePositiveInteger(
            input?.activeBurstDurationMs,
            DEFAULT_JSONL_FOLLOW_POLICY.activeBurstDurationMs,
        ),
        activeFallbackPollIntervalMs,
        idleFallbackPollIntervalMs: normalizePositiveInteger(
            input?.idleFallbackPollIntervalMs,
            DEFAULT_JSONL_FOLLOW_POLICY.idleFallbackPollIntervalMs,
        ),
        missingFileRetryIntervalMs: normalizePositiveInteger(
            input?.missingFileRetryIntervalMs,
            DEFAULT_JSONL_FOLLOW_POLICY.missingFileRetryIntervalMs,
        ),
        sidechainCompletionGraceMs: normalizeNonNegativeInteger(
            input?.sidechainCompletionGraceMs,
            DEFAULT_JSONL_FOLLOW_POLICY.sidechainCompletionGraceMs,
        ),
        maxActiveFollowersPerSession: normalizePositiveInteger(
            input?.maxActiveFollowersPerSession,
            DEFAULT_JSONL_FOLLOW_POLICY.maxActiveFollowersPerSession,
        ),
        maxIdleFollowersPerSession: normalizePositiveInteger(
            input?.maxIdleFollowersPerSession,
            DEFAULT_JSONL_FOLLOW_POLICY.maxIdleFollowersPerSession,
        ),
        maxClosedFollowerRecordsPerSession: normalizePositiveInteger(
            input?.maxClosedFollowerRecordsPerSession,
            DEFAULT_JSONL_FOLLOW_POLICY.maxClosedFollowerRecordsPerSession,
        ),
        maxBufferedSidechainRows: normalizePositiveInteger(
            input?.maxBufferedSidechainRows,
            DEFAULT_JSONL_FOLLOW_POLICY.maxBufferedSidechainRows,
        ),
        maxBufferedSidechainBytes: normalizePositiveInteger(
            input?.maxBufferedSidechainBytes,
            DEFAULT_JSONL_FOLLOW_POLICY.maxBufferedSidechainBytes,
        ),
        maxDrainRowsPerTick: normalizePositiveInteger(
            input?.maxDrainRowsPerTick,
            DEFAULT_JSONL_FOLLOW_POLICY.maxDrainRowsPerTick,
        ),
        maxDrainBytesPerTick: normalizePositiveInteger(
            input?.maxDrainBytesPerTick,
            DEFAULT_JSONL_FOLLOW_POLICY.maxDrainBytesPerTick,
        ),
    };
}

export function resolveJsonlFollowPollDelayMs(
    policy: JsonlFollowPolicyV1,
    state: JsonlFollowPollStateV1,
): number {
    if (state.missingFile) {
        return policy.missingFileRetryIntervalMs;
    }
    if (
        state.lastActivityAtMs !== null
        && state.nowMs - state.lastActivityAtMs <= policy.activeBurstDurationMs
    ) {
        return policy.activeBurstPollIntervalMs;
    }
    if (state.idle) {
        return policy.idleFallbackPollIntervalMs;
    }
    return policy.activeFallbackPollIntervalMs;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : fallback;
}
