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
     * The platform has no native worker at all (web): the JS path is the intended
     * implementation there, not a degradation. Kept distinct from `missing` so a
     * native build whose worker module is absent stays loudly visible.
     */
    unsupportedPlatform: 5,
} as const;

export type NativeCryptoWorkerProbeFailureReason =
    typeof NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON[keyof typeof NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON];

/**
 * Why a batch degraded from the native worker to the JS reference path.
 * Only genuine degradations are named here: routing that deliberately stays on
 * JS (mode `off`, or a batch below the dispatch thresholds) is not a fallback.
 */
export const NATIVE_CRYPTO_WORKER_FALLBACK_REASON = {
    probeFailed: 'probe_failed',
    unavailable: 'unavailable',
    unsupportedOperation: 'unsupported_operation',
    nativeRunFailed: 'native_run_failed',
} as const;

export type NativeCryptoWorkerFallbackReason =
    typeof NATIVE_CRYPTO_WORKER_FALLBACK_REASON[keyof typeof NATIVE_CRYPTO_WORKER_FALLBACK_REASON];

/**
 * Why routing kept a batch on the JS reference path *before* asking the worker.
 *
 * These are configured decisions, not degradations — deliberately kept out of
 * `NATIVE_CRYPTO_WORKER_FALLBACK_REASON` so a health signal built on fallbacks is
 * not polluted by working-as-configured routing. They are still recorded, because
 * an unobserved decline is indistinguishable from a broken worker from the outside:
 * a whole class of real work (every single-item `decryptDataKeyEnvelopeV1`, whose
 * bridge estimate is ~505 B against a 512 B floor) sat on the JS thread undetected
 * precisely because these three branches reported nothing.
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
    sessionId?: string | null;
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
