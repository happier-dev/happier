import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MACHINE_VITALS_STREAM_FAMILY, MACHINE_VITALS_STREAM_SOURCES, type MachineVitalsStreamUpdateV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';

import type { MachineLiveStreamCaptureRegistry } from '@/daemon/peer/mediation/stream/captureRegistry';
import type { MachineVitalsSampler } from './createMachineVitalsSampler';
import { projectMachineVitalsSample, projectMachineVitalsSnapshot } from './projectMachineVitalsRead';

/** Reuse the Machine stream's authorized viewer lifetime and the sampler's existing cadence. */
export function registerMachineVitalsLiveStream(options: Readonly<{
    registry: MachineLiveStreamCaptureRegistry;
    sampler: MachineVitalsSampler;
    readAttention: () => MachineResourceAttentionV1 | undefined;
    signal: AbortSignal;
}>): void {
    const { registry, sampler } = options;
    for (const view of ['summary', 'overview'] as const) {
        registry.register({ sourceId: MACHINE_VITALS_STREAM_SOURCES[view], streamFamily: MACHINE_VITALS_STREAM_FAMILY,
            retirementSignal: options.signal,
            adapter: { async start(input) {
                let sequence = 0;
                const send = (update: MachineVitalsStreamUpdateV1) => {
                    const payload = Buffer.from(JSON.stringify(update), 'utf8');
                    return input.offerFrame({ v: 1, streamId: input.streamId, sequence: ++sequence,
                        timestampMs: input.nowMs(), payloadKind: 'metadata', payloadEncoding: 'binary_base64',
                        payloadBase64: payload.toString('base64'), payloadSizeBytes: payload.length });
                };
                const snapshot = projectMachineVitalsSnapshot(sampler, view, options.readAttention());
                const initial = send({ v: 1, kind: 'snapshot', snapshot });
                if (!initial.ok) return initial;
                let cursor = snapshot.sample?.sampledAt ?? 0;
                const stopObserving = sampler.subscribe(() => {
                    for (const sample of sampler.samplesSince(cursor, view)) {
                        const result = send({ v: 1, kind: 'sample', sample: projectMachineVitalsSample(sample, view) });
                        if (!result.ok) {
                            input.emitReceipt({ v: 1, id: PEER_MEDIATION_RECEIPTS.streamPaused, streamId: input.streamId,
                                routeKind: input.startRequest.routeKind, flowKind: 'live_stream', terminal: true,
                                terminalOutcome: 'stopped', reasonCode: result.reasonCode });
                            return;
                        }
                        cursor = sample.sampledAt;
                    }
                });
                const release = view === 'overview' ? sampler.demandOverview() : sampler.demand('summary');
                return { ok: true, session: { stop() { stopObserving(); release(); } } };
            } },
        });
    }
}
