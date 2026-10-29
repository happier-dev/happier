import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type CryptoWorkerBatchRequest,
    type CryptoWorkerWorkClass,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';
import { bytesToCryptoWorkerBase64, cryptoWorkerBase64ToBytes } from './nativeCryptoWorkerBridgePayload';
import type { WebCryptoWorkerItem, WebCryptoWorkerResponse } from './webCryptoWorkerRuntime';

function unavailableResult<T>(request: CryptoWorkerBatchRequest<unknown>): NativeCryptoWorkerBatchResult<T> {
    if (request.signal?.aborted === true) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform);
}

type WebCryptoWorkerTransport = {
    worker?: Worker;
    ready?: Promise<Worker>;
    rejectStartup?: (error: unknown) => void;
    tail: Promise<void>;
    pending: number;
    failActiveDispatch?: (error: unknown) => void;
};

// Encryption instances share stateless document-lifetime transports. Interactive
// opens must not wait behind inventory batches; each demanded class lazily owns
// one reusable Worker, independent of Account or request count.
const transports: Record<CryptoWorkerWorkClass, WebCryptoWorkerTransport> = {
    bulk: { tail: Promise.resolve(), pending: 0 },
    interactive: { tail: Promise.resolve(), pending: 0 },
};

function discardWorker(transport: WebCryptoWorkerTransport, discarded: Worker, error?: unknown): void {
    discarded.onmessage = null;
    discarded.onerror = null;
    discarded.onmessageerror = null;
    discarded.terminate();
    if (transport.worker === discarded) {
        const rejectStartup = transport.rejectStartup;
        transport.worker = undefined;
        transport.ready = undefined;
        transport.rejectStartup = undefined;
        rejectStartup?.(error ?? new Error('Web crypto worker retired during startup'));
    }
}

function getWorkerStartup(transport: WebCryptoWorkerTransport): Promise<Worker> {
    if (transport.ready) return transport.ready;
    const created = new Worker('/happier-crypto-worker.js');
    transport.worker = created;
    const fail = (error: unknown) => {
        if (transport.worker !== created) return;
        if (transport.failActiveDispatch) transport.failActiveDispatch(error);
        else discardWorker(transport, created, error);
    };
    created.onerror = (event) => {
        event.preventDefault();
        fail(event.error instanceof Error ? event.error : new Error('Web crypto worker failed'));
    };
    created.onmessageerror = () => fail(new Error('Invalid web crypto worker message'));
    transport.ready = new Promise<Worker>((resolve, reject) => {
        transport.rejectStartup = reject;
        created.onmessage = ({ data }: MessageEvent<WebCryptoWorkerResponse>) => {
            if (data?.status !== 'ready') {
                fail(new Error('Invalid web crypto worker startup response'));
                return;
            }
            if (transport.worker !== created) return;
            transport.rejectStartup = undefined;
            created.onmessage = null;
            resolve(created);
        };
    });
    return transport.ready;
}

async function waitForWorkerReady(
    transport: WebCryptoWorkerTransport,
    signal?: AbortSignal,
    timeoutMs?: number,
): Promise<Worker> {
    const ready = getWorkerStartup(transport);
    const worker = transport.worker!;
    if (!signal && timeoutMs === undefined) return ready;
    return new Promise<Worker>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            discardWorker(transport, worker, error);
            reject(error);
        };
        const onAbort = () => fail(new Error('Web crypto worker startup cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        if (timeoutMs !== undefined) {
            timeout = setTimeout(() => fail(new Error('Web crypto worker startup timed out')), timeoutMs);
        }
        void ready.then((value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        }, (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
}

export function createNativeCryptoWorker(): NativeCryptoWorker {
    return {
        async probe() {
            return typeof Worker !== 'function' ? {
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
            } : {
                available: true,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                supportedOperations: [NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1],
            };
        },
        async decryptDataKeyEnvelopeV1(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>,
        ): Promise<NativeCryptoWorkerBatchResult<string | null>> {
            if (request.signal?.aborted) return { status: 'cancelled', source: 'cancelled', items: [] };
            if (typeof Worker !== 'function') return unavailableResult(request);
            if (request.items.length === 0) return { status: 'ok', source: 'native', items: [] };

            // Serialize each class's array request/reply protocol without
            // assigning one scope another's reply or blocking interactive opens.
            const transport = transports[request.workClass ?? 'bulk'];
            const telemetryEnabled = syncPerformanceTelemetry.isEnabled();
            const enqueuedAtMs = telemetryEnabled ? performance.now() : 0;
            const fields = () => ({
                items: request.items.length,
                interactive: request.workClass === 'interactive' ? 1 : 0,
                queued: transport.pending,
                inFlight: transport.failActiveDispatch ? 1 : 0,
            });
            const recordDepth = () => {
                if (telemetryEnabled) syncPerformanceTelemetry.count('sync.crypto.worker.web.transportDepth', fields());
            };
            transport.pending += 1;
            recordDepth();
            const previous = transport.tail;
            let release!: () => void;
            const completed = new Promise<void>((resolve) => { release = resolve; });
            transport.tail = previous.then(() => completed);
            return new Promise((resolve, reject) => {
                let dispatchedWorker: Worker | undefined;
                let dispatchedAtMs: number | undefined;
                let queued = true;
                let settled = false;
                const cleanup = (shouldDiscardWorker: boolean) => {
                    if (settled) return false;
                    settled = true;
                    request.signal?.removeEventListener('abort', onAbort);
                    if (queued) transport.pending -= 1;
                    if (dispatchedWorker) {
                        dispatchedWorker.onmessage = null;
                        transport.failActiveDispatch = undefined;
                        if (shouldDiscardWorker) discardWorker(transport, dispatchedWorker);
                    }
                    if (dispatchedAtMs !== undefined) {
                        // Elapsed transport service includes Worker startup, crypto,
                        // delivery and cancellation; it does not measure Worker CPU.
                        syncPerformanceTelemetry.recordDuration('sync.crypto.worker.web.serviceMs', performance.now() - dispatchedAtMs, fields());
                    }
                    recordDepth();
                    release();
                    return true;
                };
                const fail = (error: unknown) => {
                    if (cleanup(true)) reject(error);
                };
                const onAbort = () => {
                    if (cleanup(true)) {
                        resolve({ status: 'cancelled', source: 'cancelled', items: [] });
                    }
                };
                request.signal?.addEventListener('abort', onAbort, { once: true });
                void previous.then(async () => {
                    if (settled) return;
                    if (request.signal?.aborted) { onAbort(); return; }
                    queued = false;
                    transport.pending -= 1;
                    if (telemetryEnabled) {
                        dispatchedAtMs = performance.now();
                        syncPerformanceTelemetry.recordDuration('sync.crypto.worker.web.queueWaitMs', dispatchedAtMs - enqueuedAtMs, fields());
                    }
                    try {
                        // The Worker retains its code, never Account key state:
                        // its canonical handler wipes each request's recipient key.
                        dispatchedWorker = await waitForWorkerReady(transport, request.signal, request.startupTimeoutMs);
                        if (settled) return;
                        transport.failActiveDispatch = fail;
                        recordDepth();
                        dispatchedWorker.onmessage = ({ data }: MessageEvent<WebCryptoWorkerResponse>) => {
                            if (settled) return;
                            if (data?.status === 'error' && typeof data.error?.message === 'string'
                                && typeof data.error.name === 'string') {
                                const error = new Error(data.error.message);
                                error.name = data.error.name;
                                fail(error);
                            } else if (data?.status !== 'ok' || !Array.isArray(data.items)
                                || data.items.length !== request.items.length
                                || data.items.some(item => item !== null && (!(item instanceof Uint8Array) || item.length !== ENCRYPTED_DATA_KEY_V1_BYTES))) {
                                fail(new Error('Invalid web crypto worker response'));
                            } else {
                                const items = data.items.map(item => item ? bytesToCryptoWorkerBase64(item) : null);
                                if (cleanup(false)) resolve({ status: 'ok', source: 'native', items });
                            }
                        };
                        const items: (WebCryptoWorkerItem | null)[] = request.items.map(item => {
                            const envelope = cryptoWorkerBase64ToBytes(item.envelopeBase64);
                            const recipientSecretKeyOrSeed = cryptoWorkerBase64ToBytes(item.recipientSecretKeyOrSeedBase64);
                            return envelope && recipientSecretKeyOrSeed
                                ? { envelope: envelope.slice(), recipientSecretKeyOrSeed: recipientSecretKeyOrSeed.slice() }
                                : null;
                        });
                        dispatchedWorker.postMessage(items, items.flatMap(item => item ? [item.envelope.buffer, item.recipientSecretKeyOrSeed.buffer] : []));
                    } catch (error) {
                        fail(error);
                    }
                });
            });
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
