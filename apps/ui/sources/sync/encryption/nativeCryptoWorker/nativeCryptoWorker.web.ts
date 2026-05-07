import {
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type CryptoWorkerBatchRequest,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';

function unavailableResult<T>(request: CryptoWorkerBatchRequest<unknown>): NativeCryptoWorkerBatchResult<T> {
    if (request.signal?.aborted === true) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
}

export function createNativeCryptoWorker(): NativeCryptoWorker {
    return {
        async probe() {
            return {
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
            };
        },
        async decryptDataKeyEnvelopeV1(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>,
        ): Promise<NativeCryptoWorkerBatchResult<string | null>> {
            return unavailableResult(request);
        },
        async decryptSecretboxJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerSecretboxJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            return unavailableResult(request);
        },
        async decryptAesGcmJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerAesGcmJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            return unavailableResult(request);
        },
    };
}
