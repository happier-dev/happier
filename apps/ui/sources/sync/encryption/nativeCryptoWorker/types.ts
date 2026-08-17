export const NATIVE_CRYPTO_WORKER_OPERATION = {
    decryptDataKeyEnvelopeV1: 'decryptDataKeyEnvelopeV1',
    decryptSecretboxJson: 'decryptSecretboxJson',
    decryptAesGcmJson: 'decryptAesGcmJson',
} as const;

export type NativeCryptoWorkerOperation = typeof NATIVE_CRYPTO_WORKER_OPERATION[keyof typeof NATIVE_CRYPTO_WORKER_OPERATION];

export const NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON = {
    ok: 0,
    /** The platform ships a native worker, but this build cannot use it. */
    missing: 1,
    echoFailed: 2,
    wrongVersion: 3,
    unknown: 4,
    /**
     * The platform has no native worker at all (web): the JS path is the intended implementation
     * there, not a degradation. Kept distinct from `missing` so a native build whose worker module
     * is genuinely absent stays loudly visible instead of being buried under web noise.
     */
    unsupportedPlatform: 5,
} as const;

export type NativeCryptoWorkerProbeFailureReason =
    typeof NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON[keyof typeof NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON];

/** Why a batch that intended to run natively ended up on the JS reference path instead. */
export const NATIVE_CRYPTO_WORKER_FALLBACK_REASON = {
    probeFailed: 'probe_failed',
    unavailable: 'unavailable',
    nativeRunFailed: 'native_run_failed',
} as const;

export type NativeCryptoWorkerFallbackReason =
    typeof NATIVE_CRYPTO_WORKER_FALLBACK_REASON[keyof typeof NATIVE_CRYPTO_WORKER_FALLBACK_REASON];

/**
 * Why routing kept a batch on the JS reference path *before* asking the worker.
 *
 * These are configured decisions rather than degradations, so they stay out of
 * `NATIVE_CRYPTO_WORKER_FALLBACK_REASON` and its health counters. They are still
 * recorded, because from a profile a declined batch is indistinguishable from a
 * broken worker: both simply appear on the JS reference stack. A wrapped data key
 * estimates to ~505 bridge bytes against a 512 B floor, so every single-item
 * `decryptDataKeyEnvelopeV1` is declined by design — which is only safe to rely on
 * while it is visible.
 */
export const NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON = {
    routingDisabled: 'routing_disabled',
    belowMinBatchSize: 'below_min_batch_size',
    belowMinPayloadBytes: 'below_min_payload_bytes',
} as const;

export type NativeCryptoWorkerRoutingDeclineReason =
    typeof NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON[keyof typeof NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON];

export type CryptoWorkerScope = Readonly<{
    accountId: string;
    serverId: string | null;
    generation: number;
}>;

export type CryptoWorkerBatchRequest<T> = Readonly<{
    scope: CryptoWorkerScope;
    items: readonly T[];
    signal?: AbortSignal;
}>;

export type NativeCryptoWorkerCapability = Readonly<{
    available: boolean;
    failureReason: NativeCryptoWorkerProbeFailureReason;
    nativeVersion?: number;
    warmupMs?: number;
    supportedOperations?: readonly NativeCryptoWorkerOperation[];
}>;

export type NativeCryptoWorkerBatchSource = 'native' | 'reference' | 'cancelled';

export type NativeCryptoWorkerBatchOk<T> = Readonly<{
    status: 'ok';
    source: Exclude<NativeCryptoWorkerBatchSource, 'cancelled'>;
    items: readonly T[];
}>;

export type NativeCryptoWorkerBatchDropped = Readonly<{
    status: 'cancelled' | 'stale';
    source: NativeCryptoWorkerBatchSource;
    items: readonly [];
}>;

export type NativeCryptoWorkerBatchResult<T> = NativeCryptoWorkerBatchOk<T> | NativeCryptoWorkerBatchDropped;

export type NativeCryptoWorkerDataKeyEnvelopeItem = Readonly<{
    envelopeBase64: string;
    recipientSecretKeyOrSeedBase64: string;
}>;

export type NativeCryptoWorkerSecretboxJsonItem = Readonly<{
    ciphertextBase64: string;
    keyBase64: string;
}>;

export type NativeCryptoWorkerAesGcmJsonItem = Readonly<{
    encryptedPayloadBase64: string;
    keyBase64: string;
}>;

export interface NativeCryptoWorker {
    probe(): Promise<NativeCryptoWorkerCapability>;
    decryptDataKeyEnvelopeV1(
        request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>,
    ): Promise<NativeCryptoWorkerBatchResult<string | null>>;
    decryptSecretboxJson(
        request: CryptoWorkerBatchRequest<NativeCryptoWorkerSecretboxJsonItem>,
    ): Promise<NativeCryptoWorkerBatchResult<unknown | null>>;
    decryptAesGcmJson(
        request: CryptoWorkerBatchRequest<NativeCryptoWorkerAesGcmJsonItem>,
    ): Promise<NativeCryptoWorkerBatchResult<unknown | null>>;
}

export class NativeCryptoWorkerUnavailableError extends Error {
    readonly code = 'native_crypto_worker_unavailable';
    readonly failureReason: NativeCryptoWorkerProbeFailureReason;

    constructor(failureReason: NativeCryptoWorkerProbeFailureReason) {
        super('Native crypto worker is unavailable');
        this.name = 'NativeCryptoWorkerUnavailableError';
        this.failureReason = failureReason;
    }
}
