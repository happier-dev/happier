import { describe, expect, it } from 'vitest';

import { createDaemonPeerMediationObservabilityRuntime } from './peerMediationObservabilityRuntime';
import { createDaemonPeerMediationFlowEvent } from '../peer/mediation/observability/events';

describe('createDaemonPeerMediationObservabilityRuntime', () => {
    it('feeds emitted relay flow events into the store snapshot (counters go live)', () => {
        let now = 1_000;
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => now });

        // The snapshot starts empty (no flows observed yet → dark counters).
        expect(runtime.store.snapshot('machine_1', 'account_1').flows).toEqual([]);

        // A relay terminator would emit through `runtime.emitter`; simulate a live-stream flow start.
        runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'live_stream',
            flowId: 'stream_1',
            kind: 'flow.started',
            nowMs: now,
        }));
        now = 1_500;
        runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'live_stream',
            flowId: 'stream_1',
            kind: 'flow.closed',
            nowMs: now,
            reasonCode: 'normal_closure',
        }));

        const snapshot = runtime.store.snapshot('machine_1', 'account_1');
        expect(snapshot.flows.length).toBe(1);
        expect(snapshot.flows[0]).toMatchObject({
            flow: { flowId: 'stream_1', flowKind: 'live_stream' },
            closeReasonCode: 'normal_closure',
        });
        expect(snapshot.sequence).toBeGreaterThan(0);
    });

    it('scopes snapshots per machine/account (no cross-scope leakage)', () => {
        const runtime = createDaemonPeerMediationObservabilityRuntime({ nowMs: () => 2_000 });
        runtime.emitter.emit(createDaemonPeerMediationFlowEvent({
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'tcp_tunnel',
            flowId: 'tunnel_1',
            kind: 'flow.started',
            nowMs: 2_000,
        }));
        expect(runtime.store.snapshot('machine_1', 'account_1').flows.length).toBe(1);
        expect(runtime.store.snapshot('machine_2', 'account_1').flows).toEqual([]);
        expect(runtime.store.snapshot('machine_1', 'account_2').flows).toEqual([]);
    });
});
