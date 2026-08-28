import {
    getMachineLiveStreamPayloadDecodedByteLength,
    PEER_MEDIATION_RECEIPTS,
    validateMachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlSourceV1,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamReceiptV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import { startMachineLiveStreamFramePump } from './framePump';
import {
    classifyCaptureTerminalCloseKind,
    type MachineLiveStreamCaptureAdapter,
    type MachineLiveStreamCaptureSession,
} from './captureAdapter';
import type { MachineLiveStreamCaptureRegistry } from './captureRegistry';
import { createMachineLiveStreamSession } from './session';
import {
    createDaemonPeerMediationFlowEvent,
    type DaemonPeerMediationObservabilityEmitter,
    type DaemonPeerMediationObservabilityEventKind,
} from '../observability/events';

export type MachineLiveStreamRelayTerminator = Readonly<{
    start: (startRequest: MachineLiveStreamStartRequestV1) => Promise<
        Readonly<{ ok: true; streamId: string } | { ok: false; reasonCode: string }>
    >;
    applyControl: (envelope: MachineLiveStreamRelayEnvelopeV1) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    stop: (streamId: string) => Promise<void>;
    dispose: () => Promise<void>;
}>;

type ActiveRelayStream = Readonly<{
    captureSession: MachineLiveStreamCaptureSession;
    controlSource: MachineLiveStreamControlSourceV1 | null;
    applyTransportControl: (control: MachineLiveStreamRelayEnvelopeV1) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    startRequest: MachineLiveStreamStartRequestV1;
}>;

const TERMINAL_CAPTURE_RECEIPT_IDS = new Set<string>([
    PEER_MEDIATION_RECEIPTS.streamPaused,
    PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
]);

export const MACHINE_LIVE_STREAM_RELAY_PRE_ACTIVE_BUFFER_FRAME_LIMIT = 32;

// The per-tab viewer target rides the signed start's `viewerSocketId`. The source daemon echoes
// it onto every relay envelope it emits (start/frame/receipt) so the server relay delivers to the
// exact viewer socket (`io.to(viewerSocketId)`) on EVERY path — including the envelope-keyed
// fallbacks (cap-failure / source-control) that read the envelope rather than the stored stream
// state. Omitted on the legacy machine→machine path (no viewerSocketId in the start).
function viewerSocketIdEcho(startRequest: MachineLiveStreamStartRequestV1): Readonly<{ viewerSocketId: string }> | Record<string, never> {
    return startRequest.viewerSocketId ? { viewerSocketId: startRequest.viewerSocketId } : {};
}

function frameEnvelope(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    viewerSocketId?: string;
    frame: MachineLiveStreamFrameV1;
}>): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        ...(input.viewerSocketId ? { viewerSocketId: input.viewerSocketId } : {}),
        message: {
            kind: 'frame',
            frame: input.frame,
        },
    };
}

function receiptEnvelope(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    viewerSocketId?: string;
    receipt: MachineLiveStreamReceiptV1;
}>): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        ...(input.viewerSocketId ? { viewerSocketId: input.viewerSocketId } : {}),
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
        ...viewerSocketIdEcho(startRequest),
        message: {
            kind: 'start',
            startRequest,
        },
    };
}

function isTerminalCaptureReceipt(receipt: MachineLiveStreamReceiptV1): boolean {
    return TERMINAL_CAPTURE_RECEIPT_IDS.has(receipt.id);
}

function readFrameEnvelope(
    envelope: MachineLiveStreamRelayEnvelopeV1,
): MachineLiveStreamFrameV1 | null {
    return envelope.message.kind === 'frame' ? envelope.message.frame : null;
}

function countPendingFrameEnvelopes(envelopes: readonly MachineLiveStreamRelayEnvelopeV1[]): number {
    return envelopes.reduce((count, envelope) => count + (readFrameEnvelope(envelope) ? 1 : 0), 0);
}

function dropFirstPendingFrame(
    envelopes: MachineLiveStreamRelayEnvelopeV1[],
): MachineLiveStreamFrameV1 | null {
    const index = envelopes.findIndex((envelope) => readFrameEnvelope(envelope) !== null);
    if (index < 0) return null;
    const [removed] = envelopes.splice(index, 1);
    return removed ? readFrameEnvelope(removed) : null;
}

function dropPendingDeltasUntilKeyframe(envelopes: MachineLiveStreamRelayEnvelopeV1[]): void {
    while (true) {
        const index = envelopes.findIndex((envelope) => readFrameEnvelope(envelope) !== null);
        if (index < 0) return;
        const frame = readFrameEnvelope(envelopes[index]!);
        if (!frame || frame.payloadKind === 'image_keyframe') return;
        envelopes.splice(index, 1);
    }
}

function enqueuePendingPreActiveEnvelope(
    envelopes: MachineLiveStreamRelayEnvelopeV1[],
    envelope: MachineLiveStreamRelayEnvelopeV1,
): void {
    envelopes.push(envelope);
    let droppedKeyframe = false;
    while (countPendingFrameEnvelopes(envelopes) > MACHINE_LIVE_STREAM_RELAY_PRE_ACTIVE_BUFFER_FRAME_LIMIT) {
        const dropped = dropFirstPendingFrame(envelopes);
        if (!dropped) break;
        if (dropped.payloadKind === 'image_keyframe') droppedKeyframe = true;
    }
    if (droppedKeyframe) {
        dropPendingDeltasUntilKeyframe(envelopes);
    }
}

export function createMachineLiveStreamRelayTerminator(input: Readonly<{
    machineId: string;
    registry?: MachineLiveStreamCaptureRegistry;
    captureAdapter?: MachineLiveStreamCaptureAdapter;
    nowMs: () => number;
    emitEnvelope: (envelope: MachineLiveStreamRelayEnvelopeV1) => void;
    readActiveControlLease?: (leaseInput: Readonly<{
        streamId: string;
        sourceId: string;
        nowMs: number;
    }>) => MachineLiveStreamControlLeaseV1 | null;
    observability?: DaemonPeerMediationObservabilityEmitter;
}>): MachineLiveStreamRelayTerminator {
    const activeStreams = new Map<string, ActiveRelayStream>();
    const bytesByStreamId = new Map<string, number>();
    let disposed = false;
    let disposePromise: Promise<void> | null = null;

    function emitObservability(inputEvent: Readonly<{
        kind: DaemonPeerMediationObservabilityEventKind;
        startRequest: MachineLiveStreamStartRequestV1;
        reasonCode?: string;
        bytesOut?: number;
    }>): void {
        input.observability?.emit(createDaemonPeerMediationFlowEvent({
            accountId: inputEvent.startRequest.authorization?.payload.accountId ?? 'unknown',
            machineId: input.machineId,
            flowKind: 'live_stream',
            flowId: inputEvent.startRequest.streamId,
            kind: inputEvent.kind,
            nowMs: input.nowMs(),
            ...(inputEvent.reasonCode ? { reasonCode: inputEvent.reasonCode } : {}),
            ...(inputEvent.startRequest.authorization?.payload.grantId
                ? { routeGrantId: inputEvent.startRequest.authorization.payload.grantId }
                : {}),
            ...(inputEvent.bytesOut !== undefined ? { bytesOut: inputEvent.bytesOut } : {}),
            metadata: {
                streamFamily: inputEvent.startRequest.streamFamily,
                targetMachineId: inputEvent.startRequest.targetMachineId,
                routeKind: inputEvent.startRequest.routeKind,
            },
        }));
    }

    const closeActiveStream = async (closeInput: Readonly<{
        streamId: string;
        observabilityKind: DaemonPeerMediationObservabilityEventKind;
        reasonCode?: string;
    }>): Promise<void> => {
        const active = activeStreams.get(closeInput.streamId);
        if (!active) return;
        activeStreams.delete(closeInput.streamId);
        const bytesOut = bytesByStreamId.get(closeInput.streamId);
        bytesByStreamId.delete(closeInput.streamId);
        let reasonCode = closeInput.reasonCode;
        try {
            await active.captureSession.stop();
        } catch {
            reasonCode ??= 'capture_stop_failed';
        }
        emitObservability({
            kind: closeInput.observabilityKind,
            startRequest: active.startRequest,
            ...(reasonCode ? { reasonCode } : {}),
            ...(bytesOut !== undefined ? { bytesOut } : {}),
        });
    };

    return {
        start: async (startRequest) => {
            if (disposed) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: 'relay_disposed' });
                return { ok: false, reasonCode: 'relay_disposed' };
            }
            if (startRequest.routeKind !== 'server_relay') {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: 'invalid_route_kind' });
                return { ok: false, reasonCode: 'invalid_route_kind' };
            }
            if (startRequest.sourceMachineId !== input.machineId) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: 'source_machine_mismatch' });
                return { ok: false, reasonCode: 'source_machine_mismatch' };
            }

            const source = input.registry?.resolve({ streamFamily: startRequest.streamFamily }) ?? null;
            if (source && !source.ok && !input.captureAdapter) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: source.diagnostic.reasonCode });
                return { ok: false, reasonCode: source.diagnostic.reasonCode };
            }
            const captureAdapter = source?.ok ? source.source.adapter : input.captureAdapter;
            if (!captureAdapter) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: 'capture_source_unavailable' });
                return { ok: false, reasonCode: 'capture_source_unavailable' };
            }

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
            if (!session.ok) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: session.reasonCode });
                return { ok: false, reasonCode: session.reasonCode };
            }
            if (activeStreams.has(session.session.streamId)) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: 'duplicate_stream_id' });
                return { ok: false, reasonCode: 'duplicate_stream_id' };
            }

            // The start is accepted (authorized, deduplicated, session created) but
            // capture is not yet confirmed: emit the accepted-pre-ready lifecycle
            // point before `flow.ready` so the started/ready split is observable.
            emitObservability({ kind: 'flow.started', startRequest });

            const pendingEnvelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
            let relayActive = false;
            const emitStreamEnvelope = (envelope: MachineLiveStreamRelayEnvelopeV1): void => {
                if (relayActive) {
                    input.emitEnvelope(envelope);
                    return;
                }
                enqueuePendingPreActiveEnvelope(pendingEnvelopes, envelope);
            };

            const pump = startMachineLiveStreamFramePump({
                streamId: session.session.streamId,
                routeKind: 'server_relay',
                caps: startRequest,
                startedAtMs: session.session.startedAtMs,
                nowMs: input.nowMs,
                emitFrame: (frame) => {
                    const currentBytes = bytesByStreamId.get(session.session.streamId) ?? 0;
                    bytesByStreamId.set(
                        session.session.streamId,
                        currentBytes + getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64),
                    );
                    emitStreamEnvelope(frameEnvelope({
                        sourceMachineId: startRequest.sourceMachineId,
                        targetMachineId: startRequest.targetMachineId,
                        ...viewerSocketIdEcho(startRequest),
                        frame,
                    }));
                },
                emitReceipt: (receipt) => emitStreamEnvelope(receiptEnvelope({
                    sourceMachineId: startRequest.sourceMachineId,
                    targetMachineId: startRequest.targetMachineId,
                    ...viewerSocketIdEcho(startRequest),
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
                emitReceipt: (receipt) => {
                    input.emitEnvelope(receiptEnvelope({
                        sourceMachineId: startRequest.sourceMachineId,
                        targetMachineId: startRequest.targetMachineId,
                        ...viewerSocketIdEcho(startRequest),
                        receipt,
                    }));
                    if (isTerminalCaptureReceipt(receipt)) {
                        void closeActiveStream({
                            streamId: receipt.streamId,
                            observabilityKind: classifyCaptureTerminalCloseKind(receipt.reasonCode),
                            ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
                        });
                    }
                },
            });
            if (!capture.ok) {
                bytesByStreamId.delete(session.session.streamId);
                emitObservability({ kind: 'flow.errored', startRequest, reasonCode: capture.reasonCode });
                return { ok: false, reasonCode: capture.reasonCode };
            }
            if (disposed) {
                bytesByStreamId.delete(session.session.streamId);
                try {
                    await capture.session.stop();
                } catch {
                    // Disposal remains terminal even when the capture source cannot stop cleanly.
                }
                emitObservability({ kind: 'flow.closed', startRequest, reasonCode: 'relay_disposed' });
                return { ok: false, reasonCode: 'relay_disposed' };
            }

            activeStreams.set(session.session.streamId, {
                captureSession: capture.session,
                controlSource: source?.ok
                    ? {
                        sourceId: source.source.capabilities.sourceId,
                        inputMode: source.source.capabilities.inputMode,
                    }
                    : null,
                applyTransportControl: (envelope) => {
                    if (envelope.message.kind !== 'control') return { ok: false, reasonCode: 'invalid_control' };
                    return pump.applyControl(envelope.message.control);
                },
                startRequest,
            });
            relayActive = true;
            input.emitEnvelope(startEnvelope(startRequest));
            for (const envelope of pendingEnvelopes) input.emitEnvelope(envelope);
            pendingEnvelopes.length = 0;
            emitObservability({
                kind: 'flow.ready',
                startRequest,
                bytesOut: bytesByStreamId.get(session.session.streamId) ?? 0,
            });

            return { ok: true, streamId: session.session.streamId };
        },
        applyControl: (envelope) => {
            if (envelope.message.kind === 'control') {
                const active = activeStreams.get(envelope.message.control.streamId);
                if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
                if (envelope.message.control.kind === 'stop') {
                    void closeActiveStream({
                        streamId: envelope.message.control.streamId,
                        observabilityKind: 'flow.closed',
                        reasonCode: envelope.message.control.reasonCode ?? 'stream_stopped',
                    });
                    return { ok: true };
                }
                return active.applyTransportControl(envelope);
            }
            if (envelope.message.kind !== 'sideband_control') return { ok: false, reasonCode: 'invalid_control' };
            const active = activeStreams.get(envelope.message.control.streamId);
            if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
            const sidebandControl = active.captureSession.applySidebandControl;
            if (!sidebandControl) return { ok: false, reasonCode: 'input_not_supported' };
            const nowMs = input.nowMs();
            const controlSource = active.controlSource ?? {
                sourceId: envelope.message.control.sourceId,
                inputMode: 'exclusive',
            } satisfies MachineLiveStreamControlSourceV1;
            const leaseValidation = validateMachineLiveStreamControlLeaseV1({
                source: controlSource,
                control: envelope.message.control,
                activeLease: input.readActiveControlLease?.({
                    streamId: envelope.message.control.streamId,
                    sourceId: envelope.message.control.sourceId,
                    nowMs,
                }) ?? null,
                nowMs,
            });
            if (!leaseValidation.ok) return leaseValidation;
            return sidebandControl(envelope.message.control);
        },
        stop: async (streamId) => {
            await closeActiveStream({
                streamId,
                observabilityKind: 'flow.closed',
            });
        },
        dispose: async () => {
            if (!disposePromise) {
                disposed = true;
                disposePromise = Promise.all([...activeStreams.keys()].map(async (streamId) => {
                    await closeActiveStream({
                        streamId,
                        observabilityKind: 'flow.closed',
                        reasonCode: 'relay_disposed',
                    });
                })).then(() => undefined);
            }
            await disposePromise;
        },
    };
}
