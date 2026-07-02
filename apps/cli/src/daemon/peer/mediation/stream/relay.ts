import {
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamReceiptV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import { startMachineLiveStreamFramePump } from './framePump';
import type { MachineLiveStreamCaptureAdapter, MachineLiveStreamCaptureSession } from './captureAdapter';
import type { MachineLiveStreamCaptureRegistry } from './captureRegistry';
import { createMachineLiveStreamSession } from './session';

export type MachineLiveStreamRelayTerminator = Readonly<{
    start: (startRequest: MachineLiveStreamStartRequestV1) => Promise<
        Readonly<{ ok: true; streamId: string } | { ok: false; reasonCode: string }>
    >;
    applyControl: (envelope: MachineLiveStreamRelayEnvelopeV1) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    stop: (streamId: string) => Promise<void>;
}>;

type ActiveRelayStream = Readonly<{
    captureSession: MachineLiveStreamCaptureSession;
    applyTransportControl: (control: MachineLiveStreamRelayEnvelopeV1) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
}>;

function frameEnvelope(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    frame: MachineLiveStreamFrameV1;
}>): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        message: {
            kind: 'frame',
            frame: input.frame,
        },
    };
}

function receiptEnvelope(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    receipt: MachineLiveStreamReceiptV1;
}>): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        message: {
            kind: 'receipt',
            receipt: input.receipt,
        },
    };
}

function startEnvelope(startRequest: MachineLiveStreamStartRequestV1): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: startRequest.sourceMachineId,
        targetMachineId: startRequest.targetMachineId,
        message: {
            kind: 'start',
            startRequest,
        },
    };
}

export function createMachineLiveStreamRelayTerminator(input: Readonly<{
    machineId: string;
    registry?: MachineLiveStreamCaptureRegistry;
    captureAdapter?: MachineLiveStreamCaptureAdapter;
    nowMs: () => number;
    emitEnvelope: (envelope: MachineLiveStreamRelayEnvelopeV1) => void;
}>): MachineLiveStreamRelayTerminator {
    const activeStreams = new Map<string, ActiveRelayStream>();

    return {
        start: async (startRequest) => {
            if (startRequest.routeKind !== 'server_relay') return { ok: false, reasonCode: 'invalid_route_kind' };
            if (startRequest.sourceMachineId !== input.machineId) return { ok: false, reasonCode: 'source_machine_mismatch' };

            const source = input.registry?.resolve({ streamFamily: startRequest.streamFamily }) ?? null;
            if (source && !source.ok && !input.captureAdapter) {
                return { ok: false, reasonCode: source.diagnostic.reasonCode };
            }
            const captureAdapter = source?.ok ? source.source.adapter : input.captureAdapter;
            if (!captureAdapter) return { ok: false, reasonCode: 'capture_source_unavailable' };

            const session = createMachineLiveStreamSession({
                startRequest,
                routeDecision: {
                    kind: 'selected',
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    disabledReasons: [],
                },
                routeAuthorization: {
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    streamId: startRequest.streamId,
                    expiresAtMs: startRequest.authorization?.payload.exp ?? 0,
                },
                nowMs: input.nowMs,
            });
            if (!session.ok) return { ok: false, reasonCode: session.reasonCode };
            if (activeStreams.has(session.session.streamId)) {
                return { ok: false, reasonCode: 'duplicate_stream_id' };
            }

            const pendingEnvelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
            let relayActive = false;
            const emitStreamEnvelope = (envelope: MachineLiveStreamRelayEnvelopeV1): void => {
                if (relayActive) {
                    input.emitEnvelope(envelope);
                    return;
                }
                pendingEnvelopes.push(envelope);
            };

            const pump = startMachineLiveStreamFramePump({
                streamId: session.session.streamId,
                routeKind: 'server_relay',
                caps: startRequest,
                startedAtMs: session.session.startedAtMs,
                nowMs: input.nowMs,
                emitFrame: (frame) => emitStreamEnvelope(frameEnvelope({
                    sourceMachineId: startRequest.sourceMachineId,
                    targetMachineId: startRequest.targetMachineId,
                    frame,
                })),
                emitReceipt: (receipt) => emitStreamEnvelope(receiptEnvelope({
                    sourceMachineId: startRequest.sourceMachineId,
                    targetMachineId: startRequest.targetMachineId,
                    receipt,
                })),
            });

            const capture = await captureAdapter.start({
                streamId: session.session.streamId,
                streamFamily: startRequest.streamFamily,
                sourceMachineId: startRequest.sourceMachineId,
                targetMachineId: startRequest.targetMachineId,
                caps: startRequest,
                startRequest,
                startedAtMs: session.session.startedAtMs,
                expiresAtMs: session.session.expiresAtMs,
                nowMs: input.nowMs,
                offerFrame: pump.offerFrame,
                applyControl: pump.applyControl,
                emitReceipt: (receipt) => input.emitEnvelope(receiptEnvelope({
                    sourceMachineId: startRequest.sourceMachineId,
                    targetMachineId: startRequest.targetMachineId,
                    receipt,
                })),
            });
            if (!capture.ok) return { ok: false, reasonCode: capture.reasonCode };

            activeStreams.set(session.session.streamId, {
                captureSession: capture.session,
                applyTransportControl: (envelope) => {
                    if (envelope.message.kind !== 'control') return { ok: false, reasonCode: 'invalid_control' };
                    return pump.applyControl(envelope.message.control);
                },
            });
            relayActive = true;
            input.emitEnvelope(startEnvelope(startRequest));
            for (const envelope of pendingEnvelopes) input.emitEnvelope(envelope);
            pendingEnvelopes.length = 0;

            return { ok: true, streamId: session.session.streamId };
        },
        applyControl: (envelope) => {
            if (envelope.message.kind === 'control') {
                const active = activeStreams.get(envelope.message.control.streamId);
                if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
                return active.applyTransportControl(envelope);
            }
            if (envelope.message.kind !== 'sideband_control') return { ok: false, reasonCode: 'invalid_control' };
            const active = activeStreams.get(envelope.message.control.streamId);
            if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
            const sidebandControl = active.captureSession.applySidebandControl;
            if (!sidebandControl) return { ok: false, reasonCode: 'input_not_supported' };
            return sidebandControl(envelope.message.control);
        },
        stop: async (streamId) => {
            const active = activeStreams.get(streamId);
            activeStreams.delete(streamId);
            await active?.captureSession.stop();
        },
    };
}
