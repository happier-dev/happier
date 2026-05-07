export const NATIVE_CRYPTO_WORKER_OPERATION = {
    decryptDataKeyEnvelopeV1: 'decryptDataKeyEnvelopeV1',
    decryptSecretboxJson: 'decryptSecretboxJson',
    decryptAesGcmJson: 'decryptAesGcmJson',
} as const;

export type NativeCryptoWorkerOperation = typeof NATIVE_CRYPTO_WORKER_OPERATION[keyof typeof NATIVE_CRYPTO_WORKER_OPERATION];

export const NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON = {
    ok: 0,
    missing: 1,
    echoFailed: 2,
    wrongVersion: 3,
    unknown: 4,
} as const;

export type NativeCryptoWorkerProbeFailureReason =
    typeof NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON[keyof typeof NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON];

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
