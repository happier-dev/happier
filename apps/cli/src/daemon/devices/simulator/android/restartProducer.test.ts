import { describe, expect, it, vi } from 'vitest';

import type {
    MachineLiveStreamCapsV1,
    MachineLiveStreamControlSidebandV1,
    MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import { createSimulatorFrameProducerCaptureAdapter } from '../capture/adapter';
import type { MachineLiveStreamCaptureStartInput } from '../../../peer/mediation/stream/captureAdapter';
import type {
    SimulatorCaptureFramePayload,
    SimulatorCaptureFrameProducerStartInput,
} from '../capture/adapter';

import {
    createAndroidScrcpyServerRestartFrameProducer,
    type AndroidScrcpyServerRestartEnsureInput,
} from './restartProducer';

const caps: MachineLiveStreamCapsV1 = {
    maxBitrateBps: 8_000_000,
    maxFramesPerSecond: 60,
    maxFrameBytes: 1_048_576,
    maxDurationMs: 600_000,
};

function startCode(): readonly number[] {
    return [0x00, 0x00, 0x01];
}

function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
}

/** A complete access unit: SPS, PPS, IDR slice, then a non-IDR slice closes the IDR AU. */
function keyframeAccessUnit(): Uint8Array {
    return bytes(
        ...startCode(), 0x67, 0x64, 0x00, 0x1f,
        ...startCode(), 0x68, 0xeb, 0xec,
        ...startCode(), 0x65, 0x80, 0x84,
        ...startCode(), 0x41, 0x80, 0x9a,
        ...startCode(), 0x65, 0x80, 0x85,
    );
}

function createPushableRawStream(initialChunks: readonly Uint8Array[] = []): Readonly<{
    stream: AsyncIterable<Uint8Array>;
    push: (chunk: Uint8Array) => void;
    close: () => void;
}> {
    const queued = [...initialChunks];
    const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
    let closed = false;
    const resolveNext = (value: IteratorResult<Uint8Array>): void => {
        const waiter = waiters.shift();
        if (waiter) {
            waiter(value);
            return;
        }
        if (!value.done) queued.push(value.value);
    };
    return {
        stream: {
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    const chunk = queued.shift();
                    if (chunk) return { done: false as const, value: chunk };
                    if (closed) return { done: true as const, value: undefined };
                    return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
                        waiters.push(resolve);
                    });
                },
                return: async () => {
                    closed = true;
                    while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined });
                    return { done: true as const, value: undefined };
                },
            }),
        },
        push: (chunk) => resolveNext({ done: false, value: chunk }),
        close: () => {
            closed = true;
            while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined });
        },
    };
}

function startRequest(): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_android',
        streamFamily: 'simulator:android:emulator-5554:screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        ...caps,
    };
}

function producerStartInput(input: Readonly<{
    emitFrame: (frame: SimulatorCaptureFramePayload) => void;
    fail?: (reasonCode: string) => void;
}>): SimulatorCaptureFrameProducerStartInput {
    return {
        sourceId: 'simulator:android:emulator-5554:screen',
        streamId: 'stream_android',
        negotiatedCodecId: 'h264.avcc',
        caps,
        startRequest: startRequest(),
        emitFrame: input.emitFrame as SimulatorCaptureFrameProducerStartInput['emitFrame'],
        fail: input.fail ?? (() => undefined),
    };
}

function setQualityControl(maxBitrateBps: number): Extract<MachineLiveStreamControlSidebandV1, { kind: 'set_quality' }> {
    return {
        v: 1,
        streamId: 'stream_android',
        sourceId: 'simulator:android:emulator-5554:screen',
        eventId: `quality_${maxBitrateBps}`,
        kind: 'set_quality',
        maxBitrateBps,
    };
}

function requestKeyframeControl(): Extract<MachineLiveStreamControlSidebandV1, { kind: 'request_keyframe' }> {
    return {
        v: 1,
        streamId: 'stream_android',
        sourceId: 'simulator:android:emulator-5554:screen',
        eventId: 'keyframe_1',
        kind: 'request_keyframe',
    };
}

describe('createAndroidScrcpyServerRestartFrameProducer', () => {
    it('streams frames from the initial server and tracks encoder params per launch', async () => {
        const launchedEncoders: unknown[] = [];
        const rawStream = createPushableRawStream([keyframeAccessUnit()]);
        const ensureServer = vi.fn(async (ensure: AndroidScrcpyServerRestartEnsureInput) => {
            launchedEncoders.push(ensure.encoder ?? null);
            return {
                ok: true as const,
                rawVideoStream: rawStream.stream,
                stop: vi.fn(async () => {}),
            };
        });

        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000, maxFps: 60 },
            maxBufferedBytes: 4_096,
        });

        const emitted: SimulatorCaptureFramePayload[] = [];
        const session = await producer.start(producerStartInput({
            emitFrame: (frame) => emitted.push(frame),
        }));

        expect(ensureServer).toHaveBeenCalledTimes(1);
        expect(launchedEncoders[0]).toMatchObject({ videoBitRateBps: 4_000_000, maxFps: 60 });
        expect(emitted.length).toBeGreaterThanOrEqual(1);
        await session.stop();
    });

    it('restarts the server with the new bitrate on set_quality and re-establishes the stream WITHOUT a black-frame gap', async () => {
        const launchedEncoders: Array<Record<string, unknown> | null> = [];
        const streams = [
            createPushableRawStream([keyframeAccessUnit()]),
            createPushableRawStream([keyframeAccessUnit()]),
        ];
        let launchIndex = 0;
        const stops: Array<ReturnType<typeof vi.fn>> = [];
        const ensureServer = vi.fn(async (ensure: AndroidScrcpyServerRestartEnsureInput) => {
            const index = launchIndex;
            launchIndex += 1;
            launchedEncoders.push((ensure.encoder as Record<string, unknown> | undefined) ?? null);
            const stop = vi.fn(async () => {});
            stops.push(stop);
            return {
                ok: true as const,
                rawVideoStream: streams[index]!.stream,
                stop,
            };
        });

        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000 },
            maxBufferedBytes: 4_096,
        });

        const emitted: SimulatorCaptureFramePayload[] = [];
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'simulator:android:emulator-5554:screen',
            sourceCodecs: ['h264.avcc'],
            producer,
        });
        const startInput: MachineLiveStreamCaptureStartInput = {
            streamId: 'stream_android',
            streamFamily: 'simulator:android:emulator-5554:screen',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            caps,
            startRequest: startRequest(),
            startedAtMs: 1_000,
            expiresAtMs: 601_000,
            nowMs: () => 1_000,
            offerFrame: (frame) => {
                emitted.push(frame as unknown as SimulatorCaptureFramePayload);
                return { ok: true };
            },
            applyControl: () => ({ ok: true }),
            emitReceipt: () => undefined,
        };

        const result = await adapter.start(startInput);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('expected start');

        await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1));
        const framesBeforeRestart = emitted.length;

        // set_quality → restart with the new bitrate.
        const applied = result.session.applySidebandControl?.(setQualityControl(2_000_000));
        expect(applied).toEqual({ ok: true });

        await vi.waitFor(() => expect(ensureServer).toHaveBeenCalledTimes(2));
        expect(launchedEncoders[1]).toMatchObject({ videoBitRateBps: 2_000_000 });
        // First server torn down on restart.
        expect(stops[0]).toHaveBeenCalled();

        // New stream's first keyframe flows; no error/fail receipt; frames keep coming.
        await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(framesBeforeRestart));

        await result.session.stop();
    });

    it('treats request_keyframe as a fresh-keyframe restart with the SAME encoder params', async () => {
        const launchedEncoders: Array<Record<string, unknown> | null> = [];
        const streams = [
            createPushableRawStream([keyframeAccessUnit()]),
            createPushableRawStream([keyframeAccessUnit()]),
        ];
        let launchIndex = 0;
        const ensureServer = vi.fn(async (ensure: AndroidScrcpyServerRestartEnsureInput) => {
            const index = launchIndex;
            launchIndex += 1;
            launchedEncoders.push((ensure.encoder as Record<string, unknown> | undefined) ?? null);
            return { ok: true as const, rawVideoStream: streams[index]!.stream, stop: vi.fn(async () => {}) };
        });

        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 3_000_000, maxFps: 30 },
            maxBufferedBytes: 4_096,
        });

        const emitted: SimulatorCaptureFramePayload[] = [];
        const session = await producer.start(producerStartInput({ emitFrame: (frame) => emitted.push(frame) }));
        await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1));

        const applied = session.requestKeyframe?.(requestKeyframeControl());
        expect(applied).toEqual({ ok: true });

        await vi.waitFor(() => expect(ensureServer).toHaveBeenCalledTimes(2));
        // request_keyframe preserves the current encoder profile.
        expect(launchedEncoders[1]).toMatchObject({ videoBitRateBps: 3_000_000, maxFps: 30 });
        await session.stop();
    });

    it('NAT-4: a request_keyframe queued behind set_quality keyframes the NEW encoder (does not revert it)', async () => {
        // Two restarts are queued back-to-back: setQuality(2_000_000) then requestKeyframe(). The
        // keyframe restart must keyframe the 2_000_000-bitrate server, NOT revert to the initial
        // 4_000_000 encoder captured at schedule time. The transform is resolved at restart time.
        const launchedEncoders: Array<Record<string, unknown> | null> = [];
        const streams = [
            createPushableRawStream([keyframeAccessUnit()]),
            createPushableRawStream([keyframeAccessUnit()]),
            createPushableRawStream([keyframeAccessUnit()]),
        ];
        let launchIndex = 0;
        const ensureServer = vi.fn(async (ensure: AndroidScrcpyServerRestartEnsureInput) => {
            const index = launchIndex;
            launchIndex += 1;
            launchedEncoders.push((ensure.encoder as Record<string, unknown> | undefined) ?? null);
            return { ok: true as const, rawVideoStream: streams[index]!.stream, stop: vi.fn(async () => {}) };
        });

        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000 },
            maxBufferedBytes: 4_096,
        });

        const emitted: SimulatorCaptureFramePayload[] = [];
        const session = await producer.start(producerStartInput({ emitFrame: (frame) => emitted.push(frame) }));
        await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1));

        // Queue both restarts in the same tick so the keyframe restart is enqueued while setQuality
        // is still pending — the eager-capture bug would snapshot the pre-A (4_000_000) encoder here.
        expect(session.setQuality?.(setQualityControl(2_000_000))).toEqual({ ok: true });
        expect(session.requestKeyframe?.(requestKeyframeControl())).toEqual({ ok: true });

        await vi.waitFor(() => expect(ensureServer).toHaveBeenCalledTimes(3));
        expect(launchedEncoders[1]).toMatchObject({ videoBitRateBps: 2_000_000 });
        // The keyframe restart keyframes the live (A=2_000_000) encoder, never reverting to 4_000_000.
        expect(launchedEncoders[2]).toMatchObject({ videoBitRateBps: 2_000_000 });
        await session.stop();
    });

    it('NAT-5: stop() racing the ensureServer await tears down the just-launched server (no orphan)', async () => {
        const initialStream = createPushableRawStream([keyframeAccessUnit()]);
        // Deferred gate so stop() can run WHILE the restart's ensureServer is awaiting.
        let releaseRestart: () => void = () => {};
        const restartGate = new Promise<void>((resolve) => {
            releaseRestart = resolve;
        });
        const restartStop = vi.fn(async () => {});
        let launchIndex = 0;
        const ensureServer = vi.fn(async () => {
            const index = launchIndex;
            launchIndex += 1;
            if (index === 0) {
                return { ok: true as const, rawVideoStream: initialStream.stream, stop: vi.fn(async () => {}) };
            }
            await restartGate;
            return { ok: true as const, rawVideoStream: createPushableRawStream([keyframeAccessUnit()]).stream, stop: restartStop };
        });

        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000 },
            maxBufferedBytes: 4_096,
        });

        const emitted: SimulatorCaptureFramePayload[] = [];
        const session = await producer.start(producerStartInput({ emitFrame: (frame) => emitted.push(frame) }));
        await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1));

        // Kick a restart; it parks on restartGate inside ensureServer.
        expect(session.requestKeyframe?.(requestKeyframeControl())).toEqual({ ok: true });
        await vi.waitFor(() => expect(ensureServer).toHaveBeenCalledTimes(2));

        // stop() races the in-flight restart, then we release the gate so ensureServer resolves.
        const stopping = session.stop();
        releaseRestart();
        await stopping;

        // The post-await stopped recheck must tear down the just-launched server instead of running it.
        await vi.waitFor(() => expect(restartStop).toHaveBeenCalled());
    });

    it('fails closed when the restart server cannot be ensured', async () => {
        const rawStream = createPushableRawStream([keyframeAccessUnit()]);
        let launchIndex = 0;
        const ensureServer = vi.fn(async () => {
            const index = launchIndex;
            launchIndex += 1;
            if (index === 0) {
                return { ok: true as const, rawVideoStream: rawStream.stream, stop: vi.fn(async () => {}) };
            }
            return { ok: false as const, reasonCode: 'android_emulator_bridge_unavailable' };
        });

        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000 },
            maxBufferedBytes: 4_096,
        });

        const failures: string[] = [];
        const session = await producer.start(producerStartInput({
            emitFrame: () => undefined,
            fail: (reasonCode) => failures.push(reasonCode),
        }));
        await vi.waitFor(() => expect(session.requestKeyframe).toBeTypeOf('function'));

        const applied = session.requestKeyframe?.(requestKeyframeControl());
        // The control is accepted (restart kicked off) but the failed re-ensure surfaces a fail.
        expect(applied).toEqual({ ok: true });
        await vi.waitFor(() => expect(failures).toContain('android_emulator_bridge_unavailable'));
        await session.stop();
    });

    it('NAT-6: threads the converter\'s real dropped-byte receipts to the adaptive backpressure hook', async () => {
        // Leading noise before the first Annex-B start code is dropped by the reframer; those bytes
        // are the canonical congestion signal that must reach onCaptureBackpressure.
        const noisyFirstChunk = bytes(0xff, 0xff, 0xff, 0xff, ...keyframeAccessUnit());
        const rawStream = createPushableRawStream([noisyFirstChunk]);
        const ensureServer = vi.fn(async () => ({
            ok: true as const,
            rawVideoStream: rawStream.stream,
            stop: vi.fn(async () => {}),
        }));

        const backpressureSignals: Array<{ droppedBytes: number; capBreached: boolean }> = [];
        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000 },
            maxBufferedBytes: 4_096,
            adaptive: {
                onCaptureBackpressure: (signal) => backpressureSignals.push(signal),
            },
        });

        const emitted: SimulatorCaptureFramePayload[] = [];
        const session = await producer.start(producerStartInput({ emitFrame: (frame) => emitted.push(frame) }));
        await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1));

        // The 4 leading noise bytes were dropped and reported as a real backpressure receipt.
        await vi.waitFor(() => expect(backpressureSignals.length).toBeGreaterThanOrEqual(1));
        expect(backpressureSignals.some((s) => s.droppedBytes > 0)).toBe(true);
        await session.stop();
    });

    it('fails startup closed when the initial server cannot be ensured', async () => {
        const ensureServer = vi.fn(async () => ({
            ok: false as const,
            reasonCode: 'android_emulator_unavailable',
        }));
        const producer = createAndroidScrcpyServerRestartFrameProducer({
            ensureServer,
            initialEncoder: { videoBitRateBps: 4_000_000 },
        });

        await expect(producer.start(producerStartInput({ emitFrame: () => undefined })))
            .rejects.toMatchObject({ reasonCode: 'android_emulator_unavailable' });
    });
});
