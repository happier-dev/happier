const BASE_RETRY_CAP_MS_V1 = 5_000;
const MAX_RETRY_CAP_MS_V1 = 3 * 60 * 60 * 1_000;

/** Versioned equal-jitter policy; later attempt windows never start below an earlier window's cap. */
export function resolvePluginWebhookRetryDelayMsV1(params: Readonly<{
    attempt: number;
    random?: () => number;
}>): number {
    if (!Number.isSafeInteger(params.attempt) || params.attempt < 1 || params.attempt > 12) {
        throw new TypeError("Plugin webhook retry attempt must be an integer from 1 through 12");
    }
    const random = (params.random ?? Math.random)();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
        throw new TypeError("Plugin webhook retry randomness must be in [0, 1)");
    }
    const capMs = Math.min(
        MAX_RETRY_CAP_MS_V1,
        BASE_RETRY_CAP_MS_V1 * (2 ** (params.attempt - 1)),
    );
    const floorMs = Math.ceil(capMs / 2);
    return floorMs + Math.floor(random * (capMs - floorMs + 1));
}
