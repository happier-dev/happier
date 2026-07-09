import { resolveInitialWebPinRetryDelays } from '@/components/sessions/transcript/scroll/resolveInitialWebPinRetryDelays';

const TRANSCRIPT_WEB_INITIAL_PIN_STABILIZE_FALLBACK_MS = 1500;
const TRANSCRIPT_WEB_INITIAL_PIN_RETRY_INTERVAL_FALLBACK_MS = 250;

export type SessionOpenWebInitialPinRetryTuning = Readonly<{
    transcriptWebInitialPinRetryIntervalMs?: unknown;
    transcriptWebInitialPinRetryMilestonesMs?: readonly unknown[] | null;
    transcriptWebInitialPinStabilizeMs?: unknown;
}>;

export type SessionOpenWebInitialPinRetryPlan = Readonly<{
    retryDelaysMs: readonly number[];
    stabilizeMaxMs: number;
}>;

export function resolveSessionOpenWebInitialPinRetryPlan(
    tuning: SessionOpenWebInitialPinRetryTuning,
): SessionOpenWebInitialPinRetryPlan {
    const stabilizeMaxMsRaw = tuning.transcriptWebInitialPinStabilizeMs;
    const retryIntervalMsRaw = tuning.transcriptWebInitialPinRetryIntervalMs;
    const stabilizeMaxMs =
        typeof stabilizeMaxMsRaw === 'number' && Number.isFinite(stabilizeMaxMsRaw)
            ? Math.max(0, Math.trunc(stabilizeMaxMsRaw))
            : TRANSCRIPT_WEB_INITIAL_PIN_STABILIZE_FALLBACK_MS;
    const retryIntervalMs =
        typeof retryIntervalMsRaw === 'number' && Number.isFinite(retryIntervalMsRaw)
            ? Math.max(16, Math.trunc(retryIntervalMsRaw))
            : TRANSCRIPT_WEB_INITIAL_PIN_RETRY_INTERVAL_FALLBACK_MS;
    return {
        retryDelaysMs: resolveInitialWebPinRetryDelays({
            milestonesMs: tuning.transcriptWebInitialPinRetryMilestonesMs,
            stabilizeMaxMs,
            retryIntervalMs,
        }),
        stabilizeMaxMs,
    };
}
