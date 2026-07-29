import type {
    MachineLiveStreamCodecIdV1,
} from '@happier-dev/protocol';
import type {
    MachineLiveStreamCaptureAdapter,
    MachineLiveStreamControlApplyResult,
} from '../../../peer/mediation/stream/captureAdapter';

import type {
    SimulatorCaptureFrameProducer,
    SimulatorCaptureFrameProducerSession,
    SimulatorCaptureFrameProducerStartInput,
} from '../capture/adapter';
import {
    createSimulatorFrameProducerCaptureAdapter,
} from '../capture/adapter';
import {
    createSimulatorBitrateAdaptationController,
    DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS,
    type SimulatorBitrateAdaptationBounds,
} from '../adaptation';
import {
    AndroidScrcpyStreamError,
    createAndroidScrcpyAvccConverter,
} from './stream';
import {
    ensureAndroidScrcpyServer,
    type AndroidScrcpyServerEncoderParamsV1,
    type AndroidScrcpyServerHandle,
    type AndroidScrcpyServerHandleResult,
} from './server';
import {
    createAndroidScrcpyServerRestartFrameProducer,
    type AndroidScrcpyServerRestartEnsureResult,
} from './restartProducer';

export { AndroidScrcpyStreamError };

export type AndroidScrcpyRawStreamFrameProducerInput = Readonly<{
    rawStream: AsyncIterable<Uint8Array>;
    maxBufferedBytes?: number;
}>;

export type AndroidScrcpyServerEnsurer = (
    input: Readonly<{ serial: string; encoder?: AndroidScrcpyServerEncoderParamsV1 }>,
) => Promise<AndroidScrcpyServerHandleResult> | AndroidScrcpyServerHandleResult;

export type AndroidScrcpyServerRestarter = (
    input: Readonly<{ serial: string; encoder?: AndroidScrcpyServerEncoderParamsV1 }>,
) => Promise<AndroidScrcpyServerHandleResult> | AndroidScrcpyServerHandleResult;

export type AndroidScrcpyServerCaptureAdapterInput = Readonly<{
    serial: string;
    sourceId: string;
    ensureServer?: AndroidScrcpyServerEnsurer;
    /**
     * When supplied, the adapter uses the server-restart producer to back `set_quality` /
     * `request_keyframe` / `snapshot` (encoder reconfiguration via a clean stream restart). Without
     * it the adapter falls back to the fixed raw-stream producer (pause/resume only).
     */
    restartServer?: AndroidScrcpyServerRestarter;
    initialEncoder?: AndroidScrcpyServerEncoderParamsV1;
    /** Enable adaptive bitrate: the producer adjusts target bitrate from observed throughput. */
    adaptiveBitrate?: boolean;
    adaptiveBitrateBounds?: SimulatorBitrateAdaptationBounds;
    maxBufferedBytes?: number;
}>;

function toUint8Array(chunk: Uint8Array): Uint8Array {
    return chunk.slice();
}

function assertNegotiatedCodec(codecId: MachineLiveStreamCodecIdV1): void {
    if (codecId !== 'h264.avcc') {
        throw new AndroidScrcpyStreamError('android_scrcpy_raw_stream_codec_unsupported');
    }
}

function readStreamErrorReason(error: unknown): string {
    return error instanceof AndroidScrcpyStreamError
        ? error.reasonCode
        : 'android_scrcpy_raw_stream_failed';
}

async function failForEndedRawStream(
    cleanup: () => Promise<void>,
): Promise<never> {
    await cleanup();
    throw new AndroidScrcpyStreamError('android_scrcpy_raw_stream_ended');
}

export function createAndroidScrcpyRawStreamFrameProducer(
    input: AndroidScrcpyRawStreamFrameProducerInput,
): SimulatorCaptureFrameProducer {
    const maxBufferedBytes = input.maxBufferedBytes ?? 1024 * 1024;

    return {
        start: async (startInput: SimulatorCaptureFrameProducerStartInput): Promise<SimulatorCaptureFrameProducerSession> => {
            assertNegotiatedCodec(startInput.negotiatedCodecId);

            const iterator = input.rawStream[Symbol.asyncIterator]();
            const converter = createAndroidScrcpyAvccConverter({ maxBufferedBytes });
            let stopped = false;
            let paused = false;
            let cleanupPromise: Promise<void> | null = null;

            const cleanup = async (): Promise<void> => {
                if (cleanupPromise) return await cleanupPromise;
                stopped = true;
                cleanupPromise = (async () => {
                    await iterator.return?.();
                })();
                return await cleanupPromise;
            };

            const processChunk = (chunk: Uint8Array): number => {
                const converted = converter.push(toUint8Array(chunk));
                if (converted.reasonCode) {
                    throw new AndroidScrcpyStreamError(converted.reasonCode);
                }

                // While paused we keep draining/decoding the scrcpy raw stream so the AVCC
                // converter stays in sync and the buffer never overflows, but we suppress
                // forwarding to the viewer. Resuming begins forwarding from the next frame.
                if (paused) return 0;

                for (const frame of converted.chunks) {
                    startInput.emitFrame({
                        codecId: 'h264.avcc',
                        payload: frame.payload,
                        keyframe: frame.keyframe,
                    });
                }
                return converted.chunks.length;
            };

            let firstFrameEmitted = false;
            while (!stopped && !firstFrameEmitted) {
                const next = await iterator.next();
                if (next.done) {
                    await failForEndedRawStream(cleanup);
                }
                firstFrameEmitted = processChunk(next.value) > 0;
            }

            if (!stopped) {
                const drainAfterStart = async (): Promise<void> => {
                    try {
                        while (!stopped) {
                            const next = await iterator.next();
                            if (next.done) {
                                if (!stopped) {
                                    startInput.fail('android_scrcpy_raw_stream_ended');
                                    await cleanup();
                                }
                                break;
                            }
                            processChunk(next.value);
                        }
                    } catch (error) {
                        startInput.fail(readStreamErrorReason(error));
                        await cleanup();
                    }
                };
                setTimeout(() => {
                    if (!stopped) void drainAfterStart();
                }, 0);
            }

            return {
                stop: cleanup,
                pause: () => {
                    paused = true;
                    return { ok: true };
                },
                resume: () => {
                    paused = false;
                    return { ok: true };
                },
                // This is the fixed-stream FALLBACK producer (no restart capability wired): scrcpy
                // runs raw_stream mode with the encoder fixed at launch and no in-band control, so
                // encoder controls are unsupported here. The restart-capable path
                // (createRestartCaptureProducer → restartProducer.ts) backs these via a clean server
                // restart and is used whenever `restartServer` is supplied (production).
                requestKeyframe: () => ({ ok: false, reasonCode: 'request_keyframe_unsupported' }),
                setQuality: () => ({ ok: false, reasonCode: 'set_quality_unsupported' }),
            };
        },
    };
}

async function stopServerOnce(handle: AndroidScrcpyServerHandle): Promise<void> {
    await handle.stop();
}

function unsupportedControl(reasonCode: string): MachineLiveStreamControlApplyResult {
    return { ok: false, reasonCode };
}

/**
 * Map a full scrcpy server handle into the restart-producer's lightweight ensure result
 * ({ rawVideoStream, stop }). Fails closed when the launched server exposes no raw video stream.
 */
function toRestartEnsureResult(
    ensured: AndroidScrcpyServerHandleResult,
): AndroidScrcpyServerRestartEnsureResult {
    if (!ensured.ok) {
        return { ok: false, reasonCode: ensured.reasonCode };
    }
    const rawVideoStream = ensured.handle.rawVideoStream;
    if (!rawVideoStream) {
        void stopServerOnce(ensured.handle);
        return { ok: false, reasonCode: 'android_scrcpy_raw_stream_unavailable' };
    }
    return {
        ok: true,
        rawVideoStream,
        stop: async () => {
            await stopServerOnce(ensured.handle);
        },
    };
}

function createRestartCaptureProducer(
    input: AndroidScrcpyServerCaptureAdapterInput & {
        restartServer: AndroidScrcpyServerRestarter;
        ensureServer: AndroidScrcpyServerEnsurer;
        now?: () => number;
    },
): SimulatorCaptureFrameProducer {
    const now = input.now ?? (() => Date.now());
    const adaptiveController = input.adaptiveBitrate
        ? createSimulatorBitrateAdaptationController(
            input.adaptiveBitrateBounds ?? DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS,
        )
        : null;

    const ensure = async (ensureInput: Readonly<{ encoder?: AndroidScrcpyServerEncoderParamsV1; forceRestart?: boolean }>): Promise<AndroidScrcpyServerRestartEnsureResult> => {
        const result = ensureInput.forceRestart
            ? await input.restartServer({
                serial: input.serial,
                ...(ensureInput.encoder ? { encoder: ensureInput.encoder } : {}),
            })
            : await input.ensureServer({
                serial: input.serial,
                ...(ensureInput.encoder ? { encoder: ensureInput.encoder } : {}),
            });
        return toRestartEnsureResult(result);
    };

    return {
        start: async (startInput) => {
            // Adaptive bitrate driver: aggregate delivered bytes per ~1s window keyed on keyframes;
            // when sustained throughput moves the controller's target across the significant-change
            // threshold, drive a `set_quality` restart through the session. The session reference is
            // assigned synchronously below before any frame can be forwarded.
            let session: SimulatorCaptureFrameProducerSession | null = null;
            let windowDelivered = 0;
            let observationStartMs = now();
            // Real backpressure receipts accumulated per window from the AVCC reframer: bytes the
            // converter genuinely dropped + whether the bounded buffer breached its cap. These are
            // the canonical congestion signals (NAT-6), replacing the prior throughput-vs-cap proxy.
            let windowDroppedBytes = 0;
            let windowCapBreached = false;

            // Evaluate the controller against the closed window's REAL observation and drive an
            // adaptive restart when the target crosses the significant-change threshold.
            const evaluateWindow = (nowMs: number): void => {
                if (!adaptiveController) return;
                const result = adaptiveController.observe({
                    nowMs,
                    deliveredBytes: windowDelivered,
                    droppedBytes: windowDroppedBytes,
                    backpressure: windowCapBreached,
                });
                windowDelivered = 0;
                windowDroppedBytes = 0;
                windowCapBreached = false;
                observationStartMs = nowMs;
                if (result.shouldApply && session?.setQuality) {
                    adaptiveController.markApplied();
                    session.setQuality({
                        v: 1,
                        streamId: startInput.streamId,
                        sourceId: startInput.sourceId,
                        eventId: `adaptive_${nowMs}`,
                        kind: 'set_quality',
                        maxBitrateBps: result.targetBitrateBps,
                    });
                }
            };

            const onForwardedFrame = adaptiveController
                ? (frame: Readonly<{ payloadBytes: number; keyframe: boolean }>): void => {
                    windowDelivered += frame.payloadBytes;
                    const nowMs = now();
                    const windowMs = nowMs - observationStartMs;
                    // Window boundary: keyframe-aligned and at least ~1s, so the observation reflects a
                    // settled window. The drop/cap-breach receipts captured below feed the controller.
                    if (!frame.keyframe || windowMs < 1_000) return;
                    evaluateWindow(nowMs);
                }
                : undefined;

            const onCaptureBackpressure = adaptiveController
                ? (signal: Readonly<{ droppedBytes: number; capBreached: boolean }>): void => {
                    // Accumulate real drops/cap breaches into the live window. A cap breach is hard
                    // congestion: evaluate immediately so the downshift is not delayed to the next
                    // keyframe boundary.
                    windowDroppedBytes += signal.droppedBytes;
                    if (signal.capBreached) {
                        windowCapBreached = true;
                        evaluateWindow(now());
                    }
                }
                : undefined;

            const baseProducer = createAndroidScrcpyServerRestartFrameProducer({
                ensureServer: ensure,
                ...(input.initialEncoder ? { initialEncoder: input.initialEncoder } : {}),
                ...(input.maxBufferedBytes ? { maxBufferedBytes: input.maxBufferedBytes } : {}),
                ...((onForwardedFrame || onCaptureBackpressure)
                    ? {
                        adaptive: {
                            ...(onForwardedFrame ? { onForwardedFrame } : {}),
                            ...(onCaptureBackpressure ? { onCaptureBackpressure } : {}),
                        },
                    }
                    : {}),
            });
            session = await baseProducer.start(startInput);
            return session;
        },
    };
}

export function createAndroidScrcpyServerCaptureAdapter(
    input: AndroidScrcpyServerCaptureAdapterInput,
): MachineLiveStreamCaptureAdapter {
    const ensureServer = input.ensureServer ?? ((ensureInput) => ensureAndroidScrcpyServer(ensureInput));

    // Restart-capable path: full encoder controls (set_quality / request_keyframe / snapshot) via a
    // clean server restart. Falls back to the fixed raw-stream producer (pause/resume only) when no
    // restart capability is wired.
    if (input.restartServer) {
        return createSimulatorFrameProducerCaptureAdapter({
            sourceId: input.sourceId,
            sourceCodecs: ['h264.avcc'],
            producer: createRestartCaptureProducer({
                ...input,
                ensureServer,
                restartServer: input.restartServer,
            }),
        });
    }

    const producer: SimulatorCaptureFrameProducer = {
        start: async (startInput) => {
            const ensured = await ensureServer({ serial: input.serial });
            if (!ensured.ok) {
                throw new AndroidScrcpyStreamError(ensured.reasonCode);
            }

            const server = ensured.handle;
            const rawVideoStream = server.rawVideoStream;
            if (!rawVideoStream) {
                await stopServerOnce(server);
                throw new AndroidScrcpyStreamError('android_scrcpy_raw_stream_unavailable');
            }

            const rawProducer = createAndroidScrcpyRawStreamFrameProducer({
                rawStream: rawVideoStream,
                ...(input.maxBufferedBytes ? { maxBufferedBytes: input.maxBufferedBytes } : {}),
            });

            let session: SimulatorCaptureFrameProducerSession;
            try {
                session = await rawProducer.start(startInput);
            } catch (error) {
                await stopServerOnce(server);
                throw error;
            }

            let stopPromise: Promise<void> | null = null;
            const stop = async (): Promise<void> => {
                if (stopPromise) return await stopPromise;
                stopPromise = (async () => {
                    await session.stop();
                    await stopServerOnce(server);
                })();
                return await stopPromise;
            };

            return {
                stop,
                ...(session.requestKeyframe ? { requestKeyframe: session.requestKeyframe } : {}),
                ...(session.setQuality ? { setQuality: session.setQuality } : {}),
                pause: session.pause ?? (() => unsupportedControl('pause_unsupported')),
                resume: session.resume ?? (() => unsupportedControl('resume_unsupported')),
            };
        },
    };

    return createSimulatorFrameProducerCaptureAdapter({
        sourceId: input.sourceId,
        sourceCodecs: ['h264.avcc'],
        producer,
    });
}
