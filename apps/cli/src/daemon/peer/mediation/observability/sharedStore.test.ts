import { describe, expect, it } from 'vitest';

import type { PeerMediationObservabilityDeltaV1 } from '@happier-dev/protocol';

import { createDaemonPeerMediationObservabilityRuntime } from '../../../machine/peerMediationObservabilityRuntime';
import { createDaemonPeerMediationFlowEvent } from './events';
import { createPeerMediationObservabilityDaemonRuntimeActionExecutor } from './runtimeActionExecutor';

/**
 * PMS-WIRE cross-boundary contract: the write-path owner (the machine-sync bootstrap relay
 * terminators, which only hold the runtime's `emitter`) and the read-path owner (the runtime-action
 * dispatch, which builds an executor over the runtime's `store`) must share ONE observability store.
 *
 * This test would have caught the original bug — two separately-constructed observability runtimes —
 * because it drives the WRITER emitter and asserts the counters become visible through the READER
 * executor snapshot/subscribe, proving both ends bind to the same store instance.
 */

const ACCOUNT_ID = 'account_wire';
const MACHINE_ID = 'machine_wire';

function enabledFeaturePayload() {
    return {
        features: {
            machines: {
                enabled: true,
                peerMediation: {
                    enabled: true,
                    observability: { enabled: true },
                },
            },
        },
    };
}

function emitFlow(
    runtime: ReturnType<typeof createDaemonPeerMediationObservabilityRuntime>,
    flowId: string,
    kind: 'flow.started' | 'flow.ready',
    nowMs: number,
) {
    // The writer only ever touches the emitter — never the store directly — exactly like the
    // bootstrap relay terminators (`observability: runtime.emitter`).
    runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
        accountId: ACCOUNT_ID,
        machineId: MACHINE_ID,
        flowKind: 'tcp_tunnel',
        flowId,
        kind,
        nowMs,
    }));
}

describe('peer-mediation observability shared store (writer emitter ↔ reader executor)', () => {
    it('exposes writer-emitted flows through the reader executor snapshot', async () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 1_000 });
        const executor = createPeerMediationObservabilityDaemonRuntimeActionExecutor({
            store: runtime.store,
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            featurePayload: enabledFeaturePayload(),
        });

        emitFlow(runtime, 'tunnel_shared', 'flow.started', 1_000);

        const result = await executor({
            actionId: 'peerMediation.observability.snapshot',
            input: {},
            context: {},
        });

        expect(result).toMatchObject({
            ok: true,
            snapshot: {
                scope: { kind: 'machine', accountId: ACCOUNT_ID, machineId: MACHINE_ID },
                flows: [expect.objectContaining({ flow: expect.objectContaining({ flowId: 'tunnel_shared' }) })],
            },
        });
    });

    it('forwards writer-emitted deltas to a reader subscription', async () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 2_000 });
        const deltas: PeerMediationObservabilityDeltaV1[] = [];
        const executor = createPeerMediationObservabilityDaemonRuntimeActionExecutor({
            store: runtime.store,
            accountId: ACCOUNT_ID,
            machineId: MACHINE_ID,
            featurePayload: enabledFeaturePayload(),
            emitDelta: (delta) => deltas.push(delta),
        });

        const subscribed = await executor({
            actionId: 'peerMediation.observability.subscribe',
            input: { scope: { kind: 'machine', accountId: ACCOUNT_ID, machineId: MACHINE_ID } },
            context: {},
        });
        expect(subscribed).toMatchObject({ ok: true, sequence: 0 });

        emitFlow(runtime, 'tunnel_delta', 'flow.started', 2_001);

        expect(deltas).toHaveLength(1);
        expect(deltas[0]).toMatchObject({
            scope: { kind: 'machine', accountId: ACCOUNT_ID, machineId: MACHINE_ID },
            events: [expect.objectContaining({ flow: expect.objectContaining({ flowId: 'tunnel_delta' }) })],
        });
    });
});
