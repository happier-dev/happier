import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    NATIVE_CRYPTO_WORKER_UNAVAILABLE_CAPABILITY,
    rememberNativeCryptoWorkerCapability,
    normalizeNativeCryptoWorkerRouting,
    type NativeCryptoWorkerRoutingInput,
} from './nativeCryptoWorkerRouting';
import { recordNativeCryptoWorkerCapability } from './nativeCryptoWorkerTelemetry';
import { reportNativeCryptoWorkerFallback } from './nativeCryptoWorkerFallbackReport';
import { createNativeCryptoWorker } from './nativeCryptoWorker';
import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type NativeCryptoWorker,
    type NativeCryptoWorkerCapability,
} from './types';

export type ProbeNativeCryptoWorkerCapabilitiesOptions = Readonly<{
    worker?: NativeCryptoWorker;
    capabilityCacheKey?: object;
    routing?: NativeCryptoWorkerRoutingInput;
    telemetry?: SyncPerformanceTelemetry;
}>;

export async function probeNativeCryptoWorkerCapabilities(
    options: ProbeNativeCryptoWorkerCapabilitiesOptions = {},
): Promise<NativeCryptoWorkerCapability | null> {
    const routing = normalizeNativeCryptoWorkerRouting(options.routing);
    if (routing.mode === 'off') {
        return null;
    }

    const worker = options.worker ?? createNativeCryptoWorker();
    let capability: NativeCryptoWorkerCapability = NATIVE_CRYPTO_WORKER_UNAVAILABLE_CAPABILITY;
    try {
        capability = await worker.probe();
    } catch {
        capability = {
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown,
        };
    }
    rememberNativeCryptoWorkerCapability(options.capabilityCacheKey ?? worker, capability);

    if (!capability.available) {
        // Earliest observable point: routing would otherwise only surface this once real batches
        // start degrading, and only if the opt-in logging/telemetry happened to be enabled.
        reportNativeCryptoWorkerFallback({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            reason: NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unavailable,
            itemCount: 0,
            payloadBytes: 0,
            failureReason: capability.failureReason,
            verbose: routing.logFallbacks,
        });
    }

    if (routing.telemetryEnabled) {
        recordNativeCryptoWorkerCapability(options.telemetry ?? syncPerformanceTelemetry, capability, { mode: routing.mode });
    }

    return capability;
}
