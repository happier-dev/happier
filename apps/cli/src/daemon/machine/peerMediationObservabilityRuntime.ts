import {
    createDaemonPeerMediationObservabilityStore,
    type DaemonPeerMediationObservabilityStore,
} from '../peer/mediation/observability/store';
import type { DaemonPeerMediationObservabilityEmitter } from '../peer/mediation/observability/events';

/**
 * Bootstrap-owned peer-mediation observability runtime (PMS-9, FINALIZATION-PLAN finding #49).
 *
 * The store + emitter interface already exist under `peer/mediation/observability/**`, and both the
 * stream and TCP-tunnel relay terminators accept an optional `observability` emitter — but no
 * production caller ever constructs the store or supplies the emitter, so the daemon counters stay
 * dark. This factory is the single bootstrap seam that wires them: it owns the store instance and
 * exposes a store-backed emitter to hand to each relay terminator. It deliberately lives at the
 * bootstrap layer (not inside the mediation internals) so the wiring is supplied, not restructured.
 */
export type DaemonPeerMediationObservabilityRuntime = Readonly<{
    store: DaemonPeerMediationObservabilityStore;
    emitter: DaemonPeerMediationObservabilityEmitter;
}>;

export function createDaemonPeerMediationObservabilityRuntime(
    input: Readonly<{ nowMs?: () => number }> = {},
): DaemonPeerMediationObservabilityRuntime {
    const store = createDaemonPeerMediationObservabilityStore({
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });
    return {
        store,
        emitter: {
            emit: (event) => {
                store.publish(event);
            },
        },
    };
}
