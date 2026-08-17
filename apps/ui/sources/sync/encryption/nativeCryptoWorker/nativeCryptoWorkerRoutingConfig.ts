import { loadSyncTuning, type SyncTuning } from '@/sync/runtime/syncTuning';

import type { NativeCryptoWorkerRoutingInput } from './nativeCryptoWorkerRouting';

/**
 * Single owner of "what routing does an `Encryption` instance run under".
 *
 * `DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING` in `nativeCryptoWorkerRouting.ts` is the
 * *unconfigured* fallback (`mode: 'off'`) — the shape used when nobody has spoken.
 * The app's actual answer lives in `SyncTuning`, and it used to reach exactly one
 * instance: the active account's, via `sync.ts#configureEncryptionRuntime`. Every
 * other `Encryption` (server-scoped RPC, concurrent servers, alternate profiles)
 * silently kept the fallback and ran all crypto on the JS thread.
 *
 * The routing decision therefore belongs to construction, not to a call a new site
 * has to remember: `Encryption`'s field initializer reads
 * `getDefaultNativeCryptoWorkerRouting()`, so an instance cannot exist without it.
 * `configureNativeCryptoWorker` remains for scope binding and for tests that need a
 * different routing on purpose.
 */
function nativeCryptoWorkerRoutingFromSyncTuning(tuning: SyncTuning): NativeCryptoWorkerRoutingInput {
    return {
        mode: tuning.nativeCryptoWorkerMode,
        maxBatchSize: tuning.nativeCryptoWorkerMaxBatchSize,
        minBatchSize: tuning.nativeCryptoWorkerMinBatchSize,
        minPayloadBytes: tuning.nativeCryptoWorkerMinPayloadBytes,
        timeoutMs: tuning.nativeCryptoWorkerTimeoutMs,
        logFallbacks: tuning.nativeCryptoWorkerLogFallbacks,
        telemetryEnabled: tuning.nativeCryptoWorkerTelemetryEnabled,
        streamingSampleRate: tuning.nativeCryptoWorkerStreamingSampleRate,
        capabilityStalenessMs: tuning.nativeCryptoWorkerCapabilityStalenessMs,
    };
}

let defaultRouting: NativeCryptoWorkerRoutingInput | null = null;

/**
 * Resolved lazily on first construction, not at module import: `loadSyncTuning`
 * reads web storage and the Expo config, which are not guaranteed to be ready when
 * this module is first imported.
 */
export function getDefaultNativeCryptoWorkerRouting(): NativeCryptoWorkerRoutingInput {
    defaultRouting ??= nativeCryptoWorkerRoutingFromSyncTuning(loadSyncTuning());
    return defaultRouting;
}

export function resetDefaultNativeCryptoWorkerRoutingForTests(): void {
    defaultRouting = null;
}
