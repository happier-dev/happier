import type {
    MachineLiveStreamControlSidebandV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamControlApplyResult } from '../../../peer/mediation/stream/captureAdapter';
import type {
    SimulatorCaptureFrameProducer,
    SimulatorCaptureFrameProducerSession,
    SimulatorCaptureFrameProducerStartInput,
} from '../capture/adapter';

import type { AndroidScrcpyServerEncoderParamsV1 } from './server';
import { AndroidScrcpyStreamError, createAndroidScrcpyAvccConverter } from './stream';

/**
 * Server-restart producer for the Android scrcpy raw stream.
 *
 * scrcpy launches with `raw_stream=true`, which FIXES the H.264 encoder's bitrate / fps /
 * resolution and keyframe cadence at launch with no in-band control channel. The only way to
 * change quality or force a fresh keyframe is to restart the server with new launch args and
 * re-establish the raw stream. This producer owns that restart lifecycle and makes
 * `set_quality` (bitrate/fps/scale), `request_keyframe` (a restart yields a fresh IDR), and a
 * `snapshot` of the current decoded frame actually work — backing
 * `BACKABLE_SIMULATOR_STREAM_CONTROLS_V1`.
 *
 * UI continuity (bounded dark window, not a guaranteed seamless swap): the viewer keeps showing the
 * last decoded frame across the restart. We DO NOT forward anything from the new stream until its
 * first keyframe (IDR) access unit + AVCC description arrives, so the decoder never receives a
 * partial GOP after the swap and the cut lands on a clean keyframe rather than mid-GOP. The previous
 * server is kept alive until the new stream is established, which MINIMIZES — but does not eliminate
 * — the interval during which the viewer is holding a stale frame: the still image is held for the
 * full server relaunch + first-keyframe latency. This is a frozen-frame hold, not a zero-gap swap.
 *
 * Lifecycle races are handled explicitly: a `stop()` that races the in-flight `ensureServer` await
 * re-checks the stopped flag after the await and tears down the just-launched server, so a terminal
 * stop never leaks an orphaned scrcpy process (NAT-5).
 */

export type AndroidScrcpyServerRestartEnsureInput = Readonly<{
    encoder?: AndroidScrcpyServerEncoderParamsV1;
    /** True when the caller wants a fresh process even if encoder params are unchanged (keyframe). */
    forceRestart?: boolean;
    signal?: AbortSignal;
}>;

export type AndroidScrcpyServerRestartEnsureResult = Readonly<
    | {
        ok: true;
        rawVideoStream: AsyncIterable<Uint8Array>;
        stop: () => Promise<void> | void;
    }
    | {
        ok: false;
        reasonCode: string;
    }
>;

export type AndroidScrcpyServerRestartEnsurer = (
    input: AndroidScrcpyServerRestartEnsureInput,
) => Promise<AndroidScrcpyServerRestartEnsureResult> | AndroidScrcpyServerRestartEnsureResult;

export type AndroidScrcpyServerRestartAdaptiveBitrateHooks = Readonly<{
    /** Observe a delivered access unit's byte size; used to feed the adaptive-bitrate controller. */
    onForwardedFrame?: (input: Readonly<{ payloadBytes: number; keyframe: boolean }>) => void;
    /**
     * Real backpressure receipt from the AVCC reframer: bytes the converter actually dropped this
     * push and whether the bounded buffer breached its cap. This is the canonical congestion signal
     * (genuine drops / cap breach), threaded down so the adaptive controller reacts to observed
     * backpressure rather than an indirect throughput-vs-cap proxy.
     */
    onCaptureBackpressure?: (input: Readonly<{ droppedBytes: number; capBreached: boolean }>) => void;
}>;

export type AndroidScrcpyServerRestartFrameProducerInput = Readonly<{
    ensureServer: AndroidScrcpyServerRestartEnsurer;
    initialEncoder?: AndroidScrcpyServerEncoderParamsV1;
    maxBufferedBytes?: number;
    adaptive?: AndroidScrcpyServerRestartAdaptiveBitrateHooks;
}>;

type LastForwardedFrame = Readonly<{
    payload: Uint8Array;
    keyframe: boolean;
}>;

/**
 * A queued restart carries a transform rather than a pre-resolved encoder. The transform is applied
 * to the LIVE `currentEncoder` at restart time so concurrently-queued restarts compose correctly:
 * a `requestKeyframe` queued behind a `setQuality(A)` keyframes the A-params encoder (identity
 * transform over the live value) instead of reverting to the encoder captured when it was enqueued.
 */
type EncoderTransform = (
    current: AndroidScrcpyServerEncoderParamsV1 | undefined,
) => AndroidScrcpyServerEncoderParamsV1 | undefined;

function mergeEncoder(
    base: AndroidScrcpyServerEncoderParamsV1 | undefined,
    control: Extract<MachineLiveStreamControlSidebandV1, { kind: 'set_quality' }>,
): AndroidScrcpyServerEncoderParamsV1 {
    // set_quality carries a longest-edge resolution cap as max(maxWidth, maxHeight) → scrcpy
    // `max_size` operates on the longest edge, so collapse both dimensions into one cap.
    const maxSize = Math.max(control.maxWidth ?? 0, control.maxHeight ?? 0);
    return {
        ...(base ?? {}),
        ...(control.maxBitrateBps !== undefined ? { videoBitRateBps: control.maxBitrateBps } : {}),
        ...(control.maxFramesPerSecond !== undefined ? { maxFps: control.maxFramesPerSecond } : {}),
        ...(maxSize > 0 ? { maxSize } : {}),
    };
}

export function createAndroidScrcpyServerRestartFrameProducer(
    input: AndroidScrcpyServerRestartFrameProducerInput,
): SimulatorCaptureFrameProducer {
    const maxBufferedBytes = input.maxBufferedBytes ?? 1024 * 1024;

    return {
        start: async (startInput: SimulatorCaptureFrameProducerStartInput): Promise<SimulatorCaptureFrameProducerSession> => {
            if (startInput.negotiatedCodecId !== 'h264.avcc') {
                throw new AndroidScrcpyStreamError('android_scrcpy_raw_stream_codec_unsupported');
            }

            let currentEncoder: AndroidScrcpyServerEncoderParamsV1 | undefined = input.initialEncoder;
            let stopped = false;
            let paused = false;
            // The frame last forwarded to the viewer; held across a restart so a `snapshot` returns
            // the visible image and so we can reason about continuity.
            let lastForwarded: LastForwardedFrame | null = null;
            // While a restart is in flight the viewer keeps showing `lastForwarded`; we suppress
            // forwarding from the OLD stream and only resume on the NEW stream's first keyframe.
            let restartGeneration = 0;
            let restartInFlight: Promise<void> | null = null;

            const ensured = await input.ensureServer({
                ...(currentEncoder ? { encoder: currentEncoder } : {}),
            });
            if (!ensured.ok) {
                throw new AndroidScrcpyStreamError(ensured.reasonCode);
            }

            type ActiveServer = Readonly<{
                generation: number;
                stop: () => Promise<void> | void;
                drain: Promise<void>;
            }>;
            let active: ActiveServer | null = null;

            // Drain a server's raw stream, forwarding frames to the viewer. `awaitFirstKeyframe`
            // gates forwarding until the first keyframe (used by restarts so no partial GOP is sent
            // and the swap is keyframe-clean). Returns once the stream ends or is superseded.
            const drainServer = async (drainInput: Readonly<{
                generation: number;
                rawVideoStream: AsyncIterable<Uint8Array>;
                gateUntilKeyframe: boolean;
            }>): Promise<void> => {
                const converter = createAndroidScrcpyAvccConverter({ maxBufferedBytes });
                const iterator = drainInput.rawVideoStream[Symbol.asyncIterator]();
                let gateOpen = !drainInput.gateUntilKeyframe;
                try {
                    while (!stopped && drainInput.generation === restartGeneration) {
                        const next = await iterator.next();
                        if (next.done) {
                            if (!stopped && drainInput.generation === restartGeneration) {
                                startInput.fail('android_scrcpy_raw_stream_ended');
                                stopped = true;
                            }
                            return;
                        }
                        const converted = converter.push(next.value.slice());
                        // Thread the REAL backpressure receipt (genuine dropped bytes + cap breach)
                        // to the adaptive controller before acting on a fatal reason — drops are the
                        // canonical congestion signal, not an indirect throughput proxy.
                        if (converted.droppedBytes > 0 || converted.reasonCode) {
                            input.adaptive?.onCaptureBackpressure?.({
                                droppedBytes: converted.droppedBytes,
                                capBreached: converted.reasonCode !== undefined,
                            });
                        }
                        if (converted.reasonCode) {
                            startInput.fail(converted.reasonCode);
                            stopped = true;
                            return;
                        }
                        for (const frame of converted.chunks) {
                            if (!gateOpen) {
                                // A restart waits for the description+keyframe pair before forwarding.
                                if (frame.keyframe) gateOpen = true;
                                else continue;
                            }
                            lastForwarded = { payload: frame.payload, keyframe: frame.keyframe };
                            // While paused we keep draining/decoding so the converter stays in sync
                            // and the buffer never overflows, but we suppress viewer forwarding.
                            if (paused) continue;
                            input.adaptive?.onForwardedFrame?.({
                                payloadBytes: frame.payload.length,
                                keyframe: frame.keyframe,
                            });
                            startInput.emitFrame({
                                codecId: 'h264.avcc',
                                payload: frame.payload,
                                keyframe: frame.keyframe,
                            });
                        }
                    }
                } finally {
                    await iterator.return?.();
                }
            };

            const startActiveServer = (server: Extract<AndroidScrcpyServerRestartEnsureResult, { ok: true }>, gateUntilKeyframe: boolean): ActiveServer => {
                const generation = restartGeneration;
                const drain = drainServer({
                    generation,
                    rawVideoStream: server.rawVideoStream,
                    gateUntilKeyframe,
                });
                return { generation, stop: server.stop, drain };
            };

            active = startActiveServer(ensured, false);
            void active.drain;

            const performRestart = async (
                resolveEncoder: EncoderTransform,
            ): Promise<void> => {
                if (stopped) return;
                // Resolve the encoder against the LIVE `currentEncoder` at restart time, not at
                // schedule time. A `requestKeyframe` queued behind a `setQuality(A)` must keyframe the
                // A-params server, not revert to the pre-A encoder captured when it was enqueued.
                const encoder = resolveEncoder(currentEncoder);
                const previous = active;
                restartGeneration += 1;
                const ensuredNext = await input.ensureServer({
                    ...(encoder ? { encoder } : {}),
                    forceRestart: true,
                });
                if (stopped) {
                    // A `stop()` raced the `ensureServer` await: the new server was launched but the
                    // session is already terminal. Tear it down immediately so no orphan server runs.
                    if (ensuredNext.ok) await Promise.resolve(ensuredNext.stop()).catch(() => undefined);
                    return;
                }
                if (!ensuredNext.ok) {
                    // Tear down the stale previous server and surface the failure; the viewer keeps
                    // its last frame until the relay tears the stream down.
                    if (previous) await Promise.resolve(previous.stop()).catch(() => undefined);
                    if (!stopped) {
                        startInput.fail(ensuredNext.reasonCode);
                        stopped = true;
                    }
                    return;
                }
                currentEncoder = encoder;
                const next = startActiveServer(ensuredNext, true);
                active = next;
                void next.drain;
                // Tear down the previous server now that the new one is streaming. The viewer held
                // the last frame across this window; the new stream is gated until its first
                // keyframe so the swap is clean.
                if (previous) await Promise.resolve(previous.stop()).catch(() => undefined);
            };

            const scheduleRestart = (resolveEncoder: EncoderTransform): MachineLiveStreamControlApplyResult => {
                if (stopped) return { ok: false, reasonCode: 'capture_stopped' };
                const run = (restartInFlight ?? Promise.resolve())
                    .then(() => performRestart(resolveEncoder))
                    .catch((error: unknown) => {
                        if (!stopped) {
                            startInput.fail(error instanceof AndroidScrcpyStreamError
                                ? error.reasonCode
                                : 'android_scrcpy_server_restart_failed');
                            stopped = true;
                        }
                    })
                    .finally(() => {
                        if (restartInFlight === run) restartInFlight = null;
                    });
                restartInFlight = run;
                return { ok: true };
            };

            const stop = async (): Promise<void> => {
                stopped = true;
                restartGeneration += 1;
                const inFlight = restartInFlight;
                if (inFlight) await inFlight.catch(() => undefined);
                const current = active;
                if (current) await Promise.resolve(current.stop()).catch(() => undefined);
            };

            return {
                stop,
                pause: () => {
                    paused = true;
                    return { ok: true };
                },
                resume: () => {
                    paused = false;
                    return { ok: true };
                },
                // Enqueue a transform, NOT a pre-resolved encoder: a `requestKeyframe` queued behind
                // this must merge over the A-params encoder once it lands, never revert it.
                setQuality: (control) => scheduleRestart((current) => mergeEncoder(current, control)),
                // A restart always begins with a fresh IDR, so request_keyframe is a same-params
                // restart — it keyframes whatever encoder is live when it runs.
                requestKeyframe: () => scheduleRestart((current) => current),
                // The current decoded keyframe held by the viewer; the canonical snapshot source for
                // `simulator.snapshot.request`. Null until a first keyframe has been forwarded.
                snapshot: () => (lastForwarded
                    ? { payload: lastForwarded.payload, keyframe: lastForwarded.keyframe }
                    : null),
            };
        },
    };
}
