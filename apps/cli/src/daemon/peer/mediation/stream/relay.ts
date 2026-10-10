import { getMachineLiveStreamPayloadDecodedByteLength } from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import { isMachineLiveStreamTerminalReceiptV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';
import { MachineLiveStreamStartRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { validateMachineLiveStreamControlLeaseV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type { ActionExecutorContext, MachineLiveStreamControlLeaseV1, MachineLiveStreamControlSourceV1, MachineLiveStreamCaptureSourceKindV1, MachineLiveStreamControlV1, MachineLiveStreamFrameV1, MachineLiveStreamRelayEnvelopeV1, MachineLiveStreamReceiptV1, MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';

import { startMachineLiveStreamFramePump } from './framePump';
import {
    classifyCaptureTerminalCloseKind,
    createDaemonMachineLiveStreamCaptureAdapter,
    type MachineLiveStreamCaptureAdapter,
    type MachineLiveStreamCaptureSession,
    type MachineLiveStreamCaptureStartResult,
} from './captureAdapter';
import type { MachineLiveStreamCaptureRegistry } from './captureRegistry';
import { createMachineLiveStreamSession } from './session';
import {
    createDaemonPeerMediationFlowEvent,
    type DaemonPeerMediationObservabilityEmitter,
    type DaemonPeerMediationObservabilityEventKind,
} from '../observability/events';

export type MachineLiveStreamRelayTerminator = Readonly<{
    start: (startRequest: MachineLiveStreamStartRequestV1, callerAuthority?: ActionExecutorContext['authority']) => Promise<
        Readonly<{ ok: true; streamId: string } | { ok: false; reasonCode: string }>
    >;
    applyControl: (envelope: MachineLiveStreamRelayEnvelopeV1) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    stop: (streamId: string) => Promise<void>;
    dispose: () => Promise<void>;
}>;

type ActiveRelayStream = {
    captureSession: MachineLiveStreamCaptureSession | null;
    controlSource: MachineLiveStreamControlSourceV1 | null;
    controlSourceKind: MachineLiveStreamCaptureSourceKindV1 | undefined;
    applyTransportControl: (control: MachineLiveStreamControlV1) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    startRequest: MachineLiveStreamStartRequestV1;
    lifetimeExpiresAtMs: number;
    expiresAtMs: number;
    expiryTimer: ReturnType<typeof setTimeout> | null;
    closedReason: string | null;
    bytesOut: number;
};

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

// Renewal changes authorization time only. Capture identity, routing, codec and admitted caps
// are immutable for an active stream; the authenticated server ingress verifies the signature.
function hasSameRenewalScope(previous: MachineLiveStreamStartRequestV1, next: MachineLiveStreamStartRequestV1): boolean {
    const fields = [
        'streamId', 'streamFamily', 'sourceId', 'routeKind', 'sourceMachineId', 'targetMachineId',
        'viewerSocketId', 'codecId', 'maxBitrateBps', 'maxFramesPerSecond',
        'maxFrameBytes', 'maxDurationMs', 'maxTotalBytes',
    ] as const;
    return fields.every((field) => previous[field] === next[field])
        && JSON.stringify(previous.viewerCodecs) === JSON.stringify(next.viewerCodecs)
        && previous.authorization?.payload.accountId === next.authorization?.payload.accountId;
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
        active: ActiveRelayStream;
        observabilityKind: DaemonPeerMediationObservabilityEventKind;
        reasonCode?: string;
        emitTerminalReceipt?: boolean;
    }>): Promise<void> => {
        const active = closeInput.active;
        if (active.closedReason !== null) return;
        active.closedReason = closeInput.reasonCode ?? 'stream_stopped';
        if (activeStreams.get(active.startRequest.streamId) === active) {
            activeStreams.delete(active.startRequest.streamId);
        }
        if (active.expiryTimer !== null) clearTimeout(active.expiryTimer);
        active.expiryTimer = null;
        if (closeInput.emitTerminalReceipt !== false) {
            input.emitEnvelope(receiptEnvelope({
                sourceMachineId: active.startRequest.sourceMachineId,
                targetMachineId: active.startRequest.targetMachineId,
                ...viewerSocketIdEcho(active.startRequest),
                receipt: {
                    v: 1, id: PEER_MEDIATION_RECEIPTS.streamPaused,
                    streamId: active.startRequest.streamId, routeKind: 'server_relay', flowKind: 'live_stream',
                    reasonCode: active.closedReason, terminal: true,
                    terminalOutcome: closeInput.observabilityKind === 'flow.closed' ? 'stopped' : 'error',
                    bytesSent: active.bytesOut,
                },
            }));
        }
        let reasonCode = closeInput.reasonCode;
        try {
            await active.captureSession?.stop();
        } catch {
            reasonCode ??= 'capture_stop_failed';
        }
        emitObservability({
            kind: closeInput.observabilityKind,
            startRequest: active.startRequest,
            ...(reasonCode ? { reasonCode } : {}),
            bytesOut: active.bytesOut,
        });
    };

    function expireStream(active: ActiveRelayStream): boolean {
        if (input.nowMs() < active.expiresAtMs) return false;
        void closeActiveStream({
            active, observabilityKind: 'flow.errored',
            reasonCode: active.expiresAtMs === active.startRequest.authorization?.payload.exp
                ? 'grant_expired' : 'max_duration_ms_exceeded',
        });
        return true;
    }

    function scheduleExpiry(active: ActiveRelayStream): void {
        if (active.expiryTimer !== null) clearTimeout(active.expiryTimer);
        active.expiryTimer = setTimeout(() => {
            active.expiryTimer = null;
            if (active.closedReason !== null) return;
            if (!expireStream(active)) scheduleExpiry(active);
        }, Math.max(0, active.expiresAtMs - input.nowMs()));
        active.expiryTimer.unref?.();
    }

    return {
        start: async (startRequest, callerAuthority = 'account_automation') => {
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

            const source = input.registry?.resolve({ sourceId: startRequest.sourceId, streamFamily: startRequest.streamFamily }) ?? null;
            if (source && !source.ok && !input.captureAdapter) {
                emitObservability({ kind: 'flow.denied', startRequest, reasonCode: source.diagnostic.reasonCode });
                return { ok: false, reasonCode: source.diagnostic.reasonCode };
            }
            // Registered sources share the same occurrence/retirement owner as bootstrap-wired capture.
            const captureAdapter = input.registry ? createDaemonMachineLiveStreamCaptureAdapter(input.registry) : input.captureAdapter;
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

            let pendingKeyframe: MachineLiveStreamFrameV1 | null = null;
            let pendingMetadata: MachineLiveStreamFrameV1 | null = null;
            let requiresKeyframe = true;
            let relayActive = false;

            const emitCapturedFrame = (frame: MachineLiveStreamFrameV1): void => {
                active.bytesOut += getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
                input.emitEnvelope(frameEnvelope({
                    sourceMachineId: active.startRequest.sourceMachineId,
                    targetMachineId: active.startRequest.targetMachineId,
                    ...viewerSocketIdEcho(active.startRequest), frame,
                }));
            };

            const receiveReceipt = (receipt: MachineLiveStreamReceiptV1): void => {
                if (active.closedReason !== null || receipt.streamId !== active.startRequest.streamId) return;
                input.emitEnvelope(receiptEnvelope({
                    sourceMachineId: active.startRequest.sourceMachineId,
                    targetMachineId: active.startRequest.targetMachineId,
                    ...viewerSocketIdEcho(active.startRequest), receipt,
                }));
                if (isMachineLiveStreamTerminalReceiptV1(receipt)) {
                    void closeActiveStream({
                        active,
                        observabilityKind: classifyCaptureTerminalCloseKind(receipt.reasonCode),
                        reasonCode: receipt.reasonCode ?? 'capture_stopped',
                        emitTerminalReceipt: false,
                    });
                }
            };

            const pump = startMachineLiveStreamFramePump({
                streamId: session.session.streamId,
                routeKind: 'server_relay',
                caps: startRequest,
                startedAtMs: session.session.startedAtMs,
                nowMs: input.nowMs,
                emitFrame: (frame) => {
                    if (relayActive) {
                        if (frame.payloadKind === 'image_delta' && requiresKeyframe) return;
                        if (frame.payloadKind === 'image_keyframe') requiresKeyframe = false;
                        emitCapturedFrame(frame);
                    } else if (frame.payloadKind === 'image_keyframe') {
                        // Startup is a latest-observation projection, never a queued video history.
                        pendingKeyframe = frame;
                        requiresKeyframe = false;
                    } else if (frame.payloadKind === 'metadata') {
                        pendingMetadata = frame;
                    } else {
                        requiresKeyframe = true;
                    }
                },
                emitReceipt: receiveReceipt,
            });

            const active: ActiveRelayStream = {
                captureSession: null,
                controlSourceKind: source?.ok ? source.source.capabilities.sourceKind : undefined,
                controlSource: source?.ok ? {
                    sourceId: source.source.capabilities.sourceId,
                    inputMode: source.source.capabilities.inputMode,
                } : null,
                applyTransportControl: (control) => {
                    const result = pump.applyControl(control);
                    if (result.ok && control.kind === 'keyframe_required') requiresKeyframe = true;
                    return result;
                },
                startRequest,
                lifetimeExpiresAtMs: typeof startRequest.maxDurationMs === 'number'
                    ? session.session.startedAtMs + startRequest.maxDurationMs : Number.POSITIVE_INFINITY,
                expiresAtMs: session.session.expiresAtMs,
                expiryTimer: null, closedReason: null, bytesOut: 0,
            };
            activeStreams.set(session.session.streamId, active);
            scheduleExpiry(active);

            let capture: MachineLiveStreamCaptureStartResult;
            try {
                capture = await captureAdapter.start({
                    callerAuthority,
                    streamId: session.session.streamId,
                    streamFamily: startRequest.streamFamily,
                    sourceMachineId: startRequest.sourceMachineId,
                    targetMachineId: startRequest.targetMachineId,
                    caps: startRequest,
                    startRequest,
                    startedAtMs: session.session.startedAtMs,
                    expiresAtMs: session.session.expiresAtMs,
                    nowMs: input.nowMs,
                    offerFrame: (frame) => {
                        if (active.closedReason !== null || expireStream(active)) {
                            return { ok: false, reasonCode: 'stream_closed' };
                        }
                        return pump.offerFrame(frame);
                    },
                    applyControl: pump.applyControl,
                    emitReceipt: receiveReceipt,
                });
            } catch {
                await closeActiveStream({ active, observabilityKind: 'flow.errored', reasonCode: 'capture_start_failed' });
                return { ok: false, reasonCode: active.closedReason ?? 'capture_start_failed' };
            }
            if (!capture.ok) {
                await closeActiveStream({
                    active, observabilityKind: 'flow.errored', reasonCode: capture.reasonCode,
                });
                return { ok: false, reasonCode: active.closedReason ?? capture.reasonCode };
            }
            if (active.closedReason !== null || expireStream(active)) {
                try {
                    await capture.session.stop();
                } catch {
                    // Disposal remains terminal even when the capture source cannot stop cleanly.
                }
                return { ok: false, reasonCode: active.closedReason ?? 'grant_expired' };
            }
            active.captureSession = capture.session;
            relayActive = true;
            input.emitEnvelope(startEnvelope(active.startRequest));
            const observations: MachineLiveStreamFrameV1[] = [];
            if (pendingKeyframe) observations.push(pendingKeyframe);
            if (pendingMetadata) observations.push(pendingMetadata);
            observations.sort((left, right) => left.sequence - right.sequence);
            for (const frame of observations) {
                emitCapturedFrame(frame);
            }
            pendingKeyframe = null;
            pendingMetadata = null;
            if (requiresKeyframe) capture.session.applyControl?.({
                v: 1, streamId: startRequest.streamId, kind: 'keyframe_required', reasonCode: 'startup_keyframe_required',
            });
            emitObservability({
                kind: 'flow.ready',
                startRequest,
                bytesOut: active.bytesOut,
            });

            return { ok: true, streamId: session.session.streamId };
        },
        applyControl: (envelope) => {
            if (envelope.message.kind === 'renew') {
                const request = envelope.message.startRequest;
                const active = activeStreams.get(request.streamId);
                if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
                if (expireStream(active)) return { ok: false, reasonCode: 'grant_expired' };
                if (!hasSameRenewalScope(active.startRequest, request)
                    || envelope.sourceMachineId !== active.startRequest.sourceMachineId
                    || envelope.targetMachineId !== active.startRequest.targetMachineId
                    || envelope.viewerSocketId !== active.startRequest.viewerSocketId) {
                    return { ok: false, reasonCode: 'renewal_scope_mismatch' };
                }
                const parsed = MachineLiveStreamStartRequestV1Schema.safeParse(request);
                if (!parsed.success || !parsed.data.authorization) return { ok: false, reasonCode: 'invalid_renewal' };
                const expiresAtMs = parsed.data.authorization.payload.exp;
                if (expiresAtMs <= input.nowMs()
                    || expiresAtMs <= (active.startRequest.authorization?.payload.exp ?? 0)) {
                    return { ok: false, reasonCode: 'renewal_expiry_not_extended' };
                }
                active.startRequest = parsed.data;
                active.expiresAtMs = Math.min(expiresAtMs, active.lifetimeExpiresAtMs);
                scheduleExpiry(active);
                return { ok: true };
            }
            if (envelope.message.kind === 'control') {
                const active = activeStreams.get(envelope.message.control.streamId);
                if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
                if (expireStream(active)) return { ok: false, reasonCode: 'grant_expired' };
                if (envelope.message.control.kind === 'stop') {
                    void closeActiveStream({
                        active,
                        observabilityKind: 'flow.closed',
                        reasonCode: envelope.message.control.reasonCode ?? 'stream_stopped',
                    });
                    return { ok: true };
                }
                const applied = active.applyTransportControl(envelope.message.control);
                if (!applied.ok) return applied;
                const control = envelope.message.control;
                if (control.kind === 'ack') {
                    // The transport admits credit; demand-driven sources consume the wake-up.
                    return active.captureSession?.applyControl?.(control) ?? { ok: true };
                }
                if (control.kind === 'pause' || control.kind === 'resume' || control.kind === 'keyframe_required') {
                    if (!active.captureSession) return { ok: false, reasonCode: 'capture_start_pending' };
                    const applyCaptureControl = active.captureSession.applyControl;
                    if (!applyCaptureControl) return { ok: false, reasonCode: 'transport_control_not_supported' };
                    return applyCaptureControl(control);
                }
                return { ok: true };
            }
            if (envelope.message.kind !== 'sideband_control') return { ok: false, reasonCode: 'invalid_control' };
            const active = activeStreams.get(envelope.message.control.streamId);
            if (!active) return { ok: false, reasonCode: 'live_stream_start_required' };
            if (expireStream(active)) return { ok: false, reasonCode: 'grant_expired' };
            const sidebandControl = active.captureSession?.applySidebandControl;
            if (!sidebandControl) return { ok: false, reasonCode: 'input_not_supported' };
            const nowMs = input.nowMs();
            const controlSource = active.controlSource ?? {
                sourceId: envelope.message.control.sourceId,
                inputMode: 'exclusive',
            } satisfies MachineLiveStreamControlSourceV1;
            const leaseValidation = validateMachineLiveStreamControlLeaseV1({
                source: controlSource,
                sourceKind: active.controlSourceKind,
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
            const active = activeStreams.get(streamId);
            if (!active) return;
            await closeActiveStream({
                active,
                observabilityKind: 'flow.closed',
            });
        },
        dispose: async () => {
            if (!disposePromise) {
                disposed = true;
                disposePromise = Promise.all([...activeStreams.values()].map(async (active) => {
                    await closeActiveStream({
                        active,
                        observabilityKind: 'flow.closed',
                        reasonCode: 'relay_disposed',
                    });
                })).then(() => undefined);
            }
            await disposePromise;
        },
    };
}
