import {
    getMachineLiveStreamPayloadDecodedByteLength,
    PEER_MEDIATION_RECEIPTS,
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamCodecIdV1,
    type MachineLiveStreamControlSidebandV1,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamPayloadKindV1,
    type MachineLiveStreamReceiptV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import type {
    MachineLiveStreamCaptureAdapter,
    MachineLiveStreamCaptureStartInput,
    MachineLiveStreamControlApplyResult,
} from '../../../peer/mediation/stream/captureAdapter';

export type SimulatorCaptureFramePayload = Readonly<{
    codecId: MachineLiveStreamCodecIdV1;
    payload: Uint8Array | Buffer | string;
    keyframe?: boolean;
    timestampMs?: number;
    payloadKind?: MachineLiveStreamPayloadKindV1;
}>;

export type SimulatorCaptureReadyFrameValue = Readonly<{
    v: 1;
    timestampMs: number;
    payloadKind: MachineLiveStreamPayloadKindV1;
    payloadEncoding: 'binary_base64';
    payloadBase64: string;
    payloadSizeBytes: number;
    encryption?: MachineLiveStreamFrameV1['encryption'];
}>;

export type SimulatorCaptureReadyFrame = Readonly<{
    frame: SimulatorCaptureReadyFrameValue;
    codecId?: MachineLiveStreamCodecIdV1;
}>;

export type SimulatorCaptureProducerFrame = SimulatorCaptureFramePayload | SimulatorCaptureReadyFrame;

export type SimulatorCaptureQualityRequest = Readonly<{
    maxBitrateBps?: number;
    maxFramesPerSecond?: number;
    maxWidth?: number;
    maxHeight?: number;
}>;

export type SimulatorCaptureSnapshotV1 = Readonly<{
    payload: Uint8Array;
    keyframe: boolean;
}>;

export type SimulatorCaptureFrameProducerSession = Readonly<{
    stop: () => void | Promise<void>;
    pause?: (control: Extract<MachineLiveStreamControlSidebandV1, { kind: 'pause_capture' }>) => MachineLiveStreamControlApplyResult;
    resume?: (control: Extract<MachineLiveStreamControlSidebandV1, { kind: 'resume_capture' }>) => MachineLiveStreamControlApplyResult;
    requestKeyframe?: (control: Extract<MachineLiveStreamControlSidebandV1, { kind: 'request_keyframe' }>) => MachineLiveStreamControlApplyResult;
    setQuality?: (
        control: Extract<MachineLiveStreamControlSidebandV1, { kind: 'set_quality' }>,
    ) => MachineLiveStreamControlApplyResult;
    /** The current decoded keyframe held by the viewer; the snapshot source. Null until first keyframe. */
    snapshot?: () => SimulatorCaptureSnapshotV1 | null;
}>;

export type SimulatorCaptureFrameProducerStartInput = Readonly<{
    sourceId: string;
    streamId: string;
    negotiatedCodecId: MachineLiveStreamCodecIdV1;
    caps: MachineLiveStreamCapsV1;
    startRequest: MachineLiveStreamStartRequestV1;
    emitFrame: (frame: SimulatorCaptureProducerFrame) => void;
    fail: (reasonCode: string) => void;
}>;

export type SimulatorCaptureFrameProducer = Readonly<{
    start: (input: SimulatorCaptureFrameProducerStartInput) => Promise<SimulatorCaptureFrameProducerSession>;
}>;

export type CreateSimulatorFrameProducerCaptureAdapterInput = Readonly<{
    sourceId: string;
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    producer: SimulatorCaptureFrameProducer;
}>;

type ExtendedStartRequest = MachineLiveStreamStartRequestV1 & Readonly<{
    codecId?: unknown;
    preferredCodec?: unknown;
    viewerCodecs?: unknown;
}>;

function createStreamReceipt(input: Readonly<{
    id: typeof PEER_MEDIATION_RECEIPTS.streamPaused | typeof PEER_MEDIATION_RECEIPTS.streamBandwidthCapped;
    streamId: string;
    routeKind: MachineLiveStreamStartRequestV1['routeKind'];
    reasonCode: string;
    caps: MachineLiveStreamCapsV1;
}>): MachineLiveStreamReceiptV1 {
    return {
        v: 1,
        id: input.id,
        streamId: input.streamId,
        routeKind: input.routeKind,
        flowKind: 'live_stream',
        reasonCode: input.reasonCode,
        maxBitrateBps: input.caps.maxBitrateBps,
        maxFramesPerSecond: input.caps.maxFramesPerSecond,
        maxFrameBytes: input.caps.maxFrameBytes,
        maxDurationMs: input.caps.maxDurationMs,
        ...(input.caps.maxTotalBytes ? { maxTotalBytes: input.caps.maxTotalBytes } : {}),
    };
}

function isCodecId(value: unknown): value is MachineLiveStreamCodecIdV1 {
    return value === 'image.frame.v1' || value === 'image.mjpeg' || value === 'h264.avcc';
}

function resolveRequestedCodec(startRequest: MachineLiveStreamStartRequestV1): MachineLiveStreamCodecIdV1 | null {
    const request = startRequest as ExtendedStartRequest;
    if (isCodecId(request.codecId)) return request.codecId;
    if (isCodecId(request.preferredCodec)) return request.preferredCodec;
    return null;
}

function resolveViewerCodecs(startRequest: MachineLiveStreamStartRequestV1): readonly MachineLiveStreamCodecIdV1[] | null {
    const request = startRequest as ExtendedStartRequest;
    if (!Array.isArray(request.viewerCodecs)) return null;
    const codecs = request.viewerCodecs.filter(isCodecId);
    return codecs.length > 0 ? codecs : null;
}

function negotiateCodec(input: Readonly<{
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    startRequest: MachineLiveStreamStartRequestV1;
}>): Readonly<{ ok: true; codecId: MachineLiveStreamCodecIdV1 } | { ok: false; reasonCode: string }> {
    if (input.sourceCodecs.length === 0) return { ok: false, reasonCode: 'unsupported_codec' };

    const requestedCodec = resolveRequestedCodec(input.startRequest);
    if (requestedCodec) {
        return input.sourceCodecs.includes(requestedCodec)
            ? { ok: true, codecId: requestedCodec }
            : { ok: false, reasonCode: 'unsupported_codec' };
    }

    const viewerCodecs = resolveViewerCodecs(input.startRequest);
    if (viewerCodecs) {
        const commonCodec = input.sourceCodecs.find((codecId) => viewerCodecs.includes(codecId));
        return commonCodec ? { ok: true, codecId: commonCodec } : { ok: false, reasonCode: 'unsupported_codec' };
    }

    return {
        ok: true,
        codecId: input.sourceCodecs.includes('image.mjpeg') ? 'image.mjpeg' : input.sourceCodecs[0],
    };
}

function payloadKindForFrame(
    frame: SimulatorCaptureFramePayload,
    negotiatedCodecId: MachineLiveStreamCodecIdV1,
): MachineLiveStreamPayloadKindV1 | null {
    if (frame.payloadKind) return frame.payloadKind;
    if (negotiatedCodecId === 'image.mjpeg' || negotiatedCodecId === 'image.frame.v1') return 'image_keyframe';
    if (negotiatedCodecId === 'h264.avcc') return frame.keyframe === false ? 'image_delta' : 'image_keyframe';
    return null;
}

function payloadToBase64(payload: SimulatorCaptureFramePayload['payload']): string | null {
    if (typeof payload === 'string') return payload.length > 0 ? payload : null;
    if (payload.byteLength <= 0) return null;
    return Buffer.from(payload).toString('base64');
}

function normalizeProducerFrame(input: Readonly<{
    frame: SimulatorCaptureProducerFrame;
    streamId: string;
    sequence: number;
    nowMs: () => number;
    negotiatedCodecId: MachineLiveStreamCodecIdV1;
}>): Readonly<{ ok: true; frame: MachineLiveStreamFrameV1 } | { ok: false; reasonCode: string }> {
    if ('frame' in input.frame) {
        const frame = input.frame.frame;
        if (frame.payloadEncoding !== 'binary_base64') return { ok: false, reasonCode: 'invalid_frame' };
        if (frame.payloadBase64.length <= 0) return { ok: false, reasonCode: 'invalid_frame' };
        if (input.frame.codecId && input.frame.codecId !== input.negotiatedCodecId) {
            return { ok: false, reasonCode: 'codec_not_negotiated' };
        }
        const payloadSizeBytes = getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
        if (payloadSizeBytes !== frame.payloadSizeBytes) return { ok: false, reasonCode: 'invalid_frame' };
        return {
            ok: true,
            frame: {
                ...frame,
                v: 1,
                streamId: input.streamId,
                sequence: input.sequence,
                timestampMs: frame.timestampMs,
                payloadEncoding: 'binary_base64',
                payloadSizeBytes,
                codecId: input.frame.codecId ?? input.negotiatedCodecId,
            },
        };
    }

    if (input.frame.codecId !== input.negotiatedCodecId) return { ok: false, reasonCode: 'codec_not_negotiated' };

    const payloadBase64 = payloadToBase64(input.frame.payload);
    if (!payloadBase64) return { ok: false, reasonCode: 'invalid_frame' };

    const payloadKind = payloadKindForFrame(input.frame, input.negotiatedCodecId);
    if (!payloadKind) return { ok: false, reasonCode: 'invalid_frame' };

    return {
        ok: true,
        frame: {
            v: 1,
            streamId: input.streamId,
            sequence: input.sequence,
            timestampMs: input.frame.timestampMs ?? input.nowMs(),
            payloadKind,
            payloadEncoding: 'binary_base64',
            payloadBase64,
            payloadSizeBytes: getMachineLiveStreamPayloadDecodedByteLength(payloadBase64),
            codecId: input.negotiatedCodecId,
        },
    };
}

function readProducerStartFailureReason(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
    return typeof reasonCode === 'string' && reasonCode.length > 0 ? reasonCode : null;
}

export function createSimulatorFrameProducerCaptureAdapter(
    input: CreateSimulatorFrameProducerCaptureAdapterInput,
): MachineLiveStreamCaptureAdapter {
    return {
        start: async (startInput) => {
            const negotiated = negotiateCodec({
                sourceCodecs: input.sourceCodecs,
                startRequest: startInput.startRequest,
            });
            if (!negotiated.ok) {
                startInput.emitReceipt(createStreamReceipt({
                    id: PEER_MEDIATION_RECEIPTS.streamPaused,
                    streamId: startInput.streamId,
                    routeKind: startInput.startRequest.routeKind,
                    reasonCode: negotiated.reasonCode,
                    caps: startInput.caps,
                }));
                return { ok: false, reasonCode: negotiated.reasonCode };
            }

            let sequence = 1;
            let producerSession: SimulatorCaptureFrameProducerSession | null = null;
            let failureReason: string | null = null;
            let pendingStop = false;
            let captureClosed = false;
            let producerStopInvoked = false;

            const stopProducer = async (): Promise<void> => {
                captureClosed = true;
                if (!producerSession) {
                    pendingStop = true;
                    return;
                }
                if (producerStopInvoked) return;
                producerStopInvoked = true;
                await producerSession.stop();
            };

            const failClosed = (reasonCode: string): void => {
                if (captureClosed) return;
                if (!failureReason) {
                    failureReason = reasonCode;
                }
                startInput.emitReceipt(createStreamReceipt({
                    id: reasonCode.startsWith('max_')
                        ? PEER_MEDIATION_RECEIPTS.streamBandwidthCapped
                        : PEER_MEDIATION_RECEIPTS.streamPaused,
                    streamId: startInput.streamId,
                    routeKind: startInput.startRequest.routeKind,
                    reasonCode,
                    caps: startInput.caps,
                }));
                void stopProducer();
            };

            try {
                producerSession = await input.producer.start({
                    sourceId: input.sourceId,
                    streamId: startInput.streamId,
                    negotiatedCodecId: negotiated.codecId,
                    caps: startInput.caps,
                    startRequest: startInput.startRequest,
                    fail: failClosed,
                    emitFrame: (producerFrame) => {
                        if (captureClosed) return;
                        const frame = normalizeProducerFrame({
                            frame: producerFrame,
                            streamId: startInput.streamId,
                            sequence,
                            nowMs: startInput.nowMs,
                            negotiatedCodecId: negotiated.codecId,
                        });
                        if (!frame.ok) {
                            failClosed(frame.reasonCode);
                            return;
                        }
                        const offer = startInput.offerFrame(frame.frame);
                        if (!offer.ok) {
                            failClosed(offer.reasonCode);
                            return;
                        }
                        sequence += 1;
                    },
                });
            } catch (error) {
                return { ok: false, reasonCode: failureReason ?? readProducerStartFailureReason(error) ?? 'producer_start_failed' };
            }

            if (pendingStop || failureReason) {
                await stopProducer();
                return { ok: false, reasonCode: failureReason ?? 'capture_stopped' };
            }

            return {
                ok: true,
                session: {
                    stop: stopProducer,
                    applySidebandControl: (control) => {
                        if (captureClosed) return { ok: false, reasonCode: 'capture_stopped' };
                        return applyProducerControl({
                            control,
                            sourceId: input.sourceId,
                            streamId: startInput.streamId,
                            session: producerSession,
                        });
                    },
                },
            };
        },
    };
}

function applyProducerControl(input: Readonly<{
    control: MachineLiveStreamControlSidebandV1;
    sourceId: string;
    streamId: string;
    session: SimulatorCaptureFrameProducerSession | null;
}>): MachineLiveStreamControlApplyResult {
    if (input.control.streamId !== input.streamId || input.control.sourceId !== input.sourceId) {
        return { ok: false, reasonCode: 'invalid_control' };
    }
    if (!input.session) return { ok: false, reasonCode: 'capture_stopped' };

    if (input.control.kind === 'request_keyframe') {
        return input.session.requestKeyframe?.(input.control) ?? { ok: false, reasonCode: 'request_keyframe_unsupported' };
    }
    if (input.control.kind === 'set_quality') {
        return input.session.setQuality?.(input.control) ?? { ok: false, reasonCode: 'set_quality_unsupported' };
    }
    if (input.control.kind === 'pause_capture') {
        return input.session.pause?.(input.control) ?? { ok: false, reasonCode: 'pause_unsupported' };
    }
    if (input.control.kind === 'resume_capture') {
        return input.session.resume?.(input.control) ?? { ok: false, reasonCode: 'resume_unsupported' };
    }
    return { ok: false, reasonCode: 'input_not_supported' };
}
