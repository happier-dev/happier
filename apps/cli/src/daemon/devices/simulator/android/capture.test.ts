import { describe, expect, it, vi } from 'vitest';

import type {
    MachineLiveStreamCapsV1,
    MachineLiveStreamFrameV1,
    MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import {
    createSimulatorFrameProducerCaptureAdapter,
} from '../capture/adapter';
import type { MachineLiveStreamCaptureStartInput } from '../../../peer/mediation/stream/captureAdapter';
import type { AndroidScrcpyServerHandleResult } from './server';

const caps: MachineLiveStreamCapsV1 = {
    maxBitrateBps: 256_000,
    maxFramesPerSecond: 30,
    maxFrameBytes: 16_384,
    maxDurationMs: 60_000,
    maxTotalBytes: 512_000,
};

function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
}

function startCode(): readonly number[] {
    return [0x00, 0x00, 0x01];
}

function startRequest(extra: Partial<MachineLiveStreamStartRequestV1> = {}): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_android',
        streamFamily: 'simulator:android:emulator-5554:screen',
        routeKind: 'loopback_direct',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        ...caps,
        ...extra,
    };
}

function startInput(input: Readonly<{
    offerFrame?: MachineLiveStreamCaptureStartInput['offerFrame'];
    emitReceipt?: MachineLiveStreamCaptureStartInput['emitReceipt'];
    startRequest?: MachineLiveStreamStartRequestV1;
}> = {}): MachineLiveStreamCaptureStartInput {
    const request = input.startRequest ?? startRequest({ preferredCodec: 'h264.avcc' } as Partial<MachineLiveStreamStartRequestV1>);
    return {
        streamId: request.streamId,
        streamFamily: request.streamFamily,
        sourceMachineId: request.sourceMachineId,
        targetMachineId: request.targetMachineId,
        caps,
        startRequest: request,
        startedAtMs: 1_000,
        expiresAtMs: 61_000,
        nowMs: () => 1_234,
        offerFrame: input.offerFrame ?? (() => ({ ok: true })),
        applyControl: () => ({ ok: true }),
        emitReceipt: input.emitReceipt ?? (() => undefined),
    };
}

async function* rawChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) {
        yield chunk;
    }
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
                    while (waiters.length > 0) {
                        waiters.shift()?.({ done: true, value: undefined });
                    }
                    return { done: true as const, value: undefined };
                },
            }),
        },
        push: (chunk) => resolveNext({ done: false, value: chunk }),
        close: () => {
            closed = true;
            while (waiters.length > 0) {
                waiters.shift()?.({ done: true, value: undefined });
            }
        },
    };
}

describe('Android scrcpy raw-stream capture bridge', () => {
    it('feeds converted AVCC description and keyframe frames into the platform-neutral capture adapter', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyRawStreamFrameProducer');
        if (!('createAndroidScrcpyRawStreamFrameProducer' in mod)) return;

        const offeredFrames: MachineLiveStreamFrameV1[] = [];
        const producer = mod.createAndroidScrcpyRawStreamFrameProducer({
            rawStream: rawChunks([
                bytes(
                    ...startCode(), 0x67, 0x64, 0x00, 0x1f,
                    ...startCode(), 0x68, 0xeb, 0xec,
                    ...startCode(), 0x65, 0x80, 0x84,
                    ...startCode(), 0x41, 0x80, 0x9a,
                    ...startCode(), 0x65, 0x80, 0x85,
                ),
            ]),
            maxBufferedBytes: 256,
        });
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'simulator:android:emulator-5554:screen',
            sourceCodecs: ['h264.avcc'],
            producer,
        });

        const result = await adapter.start(startInput({
            offerFrame: (frame) => {
                offeredFrames.push(frame);
                return { ok: true };
            },
        }));

        expect(result).toMatchObject({ ok: true });
        expect(offeredFrames).toEqual([
            expect.objectContaining({
                streamId: 'stream_android',
                sequence: 1,
                payloadKind: 'image_keyframe',
                codecId: 'h264.avcc',
                payloadSizeBytes: 23,
            }),
            expect.objectContaining({
                streamId: 'stream_android',
                sequence: 2,
                payloadKind: 'image_keyframe',
                codecId: 'h264.avcc',
                payloadSizeBytes: 12,
            }),
        ]);
    });

    it('pauses and resumes raw-stream frame forwarding through the sideband control path', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyRawStreamFrameProducer');
        if (!('createAndroidScrcpyRawStreamFrameProducer' in mod)) return;

        // SPS+PPS+IDR description frame plus a slice; the trailing start code closes the
        // first access unit so the converter forwards it (matching the canonical fixture).
        const rawStream = createPushableRawStream([
            bytes(
                ...startCode(), 0x67, 0x64, 0x00, 0x1f,
                ...startCode(), 0x68, 0xeb, 0xec,
                ...startCode(), 0x65, 0x80, 0x84,
                ...startCode(), 0x41, 0x80, 0x9a,
                ...startCode(), 0x65, 0x80, 0x85,
            ),
        ]);
        const offeredFrames: MachineLiveStreamFrameV1[] = [];
        const producer = mod.createAndroidScrcpyRawStreamFrameProducer({
            rawStream: rawStream.stream,
            maxBufferedBytes: 256,
        });
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'simulator:android:emulator-5554:screen',
            sourceCodecs: ['h264.avcc'],
            producer,
        });

        const result = await adapter.start(startInput({
            offerFrame: (frame) => {
                offeredFrames.push(frame);
                return { ok: true };
            },
        }));

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('expected capture start');

        await vi.waitFor(() => {
            expect(offeredFrames.length).toBeGreaterThanOrEqual(1);
        });
        const framesBeforePause = offeredFrames.length;

        const pauseResult = result.session.applySidebandControl?.({
            v: 1,
            streamId: 'stream_android',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event_pause',
            kind: 'pause_capture',
        });
        expect(pauseResult).toEqual({ ok: true });

        // A complete access unit (slice + trailing start code) arrives while paused: it is
        // drained/decoded but must NOT be forwarded to the viewer.
        rawStream.push(bytes(...startCode(), 0x41, 0x80, 0x9b, ...startCode(), 0x41, 0x80, 0x9c));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(offeredFrames.length).toBe(framesBeforePause);

        const resumeResult = result.session.applySidebandControl?.({
            v: 1,
            streamId: 'stream_android',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event_resume',
            kind: 'resume_capture',
        });
        expect(resumeResult).toEqual({ ok: true });

        // After resume, a new complete access unit is forwarded again.
        rawStream.push(bytes(...startCode(), 0x41, 0x80, 0x9d, ...startCode(), 0x41, 0x80, 0x9e));
        await vi.waitFor(() => {
            expect(offeredFrames.length).toBeGreaterThan(framesBeforePause);
        });
    });

    it('fails closed before emitting frames when raw H.264 cannot be converted to AVCC', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyRawStreamFrameProducer');
        if (!('createAndroidScrcpyRawStreamFrameProducer' in mod)) return;

        const producer = mod.createAndroidScrcpyRawStreamFrameProducer({
            rawStream: rawChunks([
                bytes(...startCode(), 0x65, 0x88, 0x84, ...startCode(), 0x41, 0x9a),
            ]),
            maxBufferedBytes: 128,
        });

        await expect(producer.start({
            sourceId: 'simulator:android:emulator-5554:screen',
            streamId: 'stream_android',
            negotiatedCodecId: 'h264.avcc',
            caps,
            startRequest: startRequest(),
            emitFrame: vi.fn(),
            fail: vi.fn(),
        })).rejects.toMatchObject({
            reasonCode: 'android_scrcpy_avcc_description_unavailable',
        });
    });

    it('reports post-start raw stream failures through the capture adapter fatal path', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyRawStreamFrameProducer');
        if (!('createAndroidScrcpyRawStreamFrameProducer' in mod)) return;

        const rawStream = createPushableRawStream([
            bytes(
                ...startCode(), 0x67, 0x64, 0x00, 0x1f,
                ...startCode(), 0x68, 0xeb, 0xec,
                ...startCode(), 0x65, 0x80, 0x84,
                ...startCode(), 0x41, 0x80, 0x9a,
                ...startCode(), 0x65, 0x80, 0x85,
            ),
        ]);
        const receipts: unknown[] = [];
        const producer = mod.createAndroidScrcpyRawStreamFrameProducer({
            rawStream: rawStream.stream,
            maxBufferedBytes: 16,
        });
        const adapter = createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'simulator:android:emulator-5554:screen',
            sourceCodecs: ['h264.avcc'],
            producer,
        });

        const result = await adapter.start(startInput({
            emitReceipt: (receipt) => receipts.push(receipt),
        }));

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('expected capture start');

        rawStream.push(bytes(0x00, 0x00, 0x01, 0x65, ...Array.from({ length: 32 }, () => 0x88)));

        await vi.waitFor(() => {
            expect(receipts).toEqual([expect.objectContaining({
                id: 'peer.stream.paused',
                reasonCode: 'android_scrcpy_raw_stream_buffer_limit_exceeded',
            })]);
        });
        expect(result.session.applySidebandControl?.({
            v: 1,
            streamId: 'stream_android',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event_keyframe',
            kind: 'request_keyframe',
        })).toEqual({ ok: false, reasonCode: 'capture_stopped' });
    });

    it('reports post-start raw stream EOF and stops the scrcpy server handle', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyServerCaptureAdapter');
        if (!('createAndroidScrcpyServerCaptureAdapter' in mod)) return;

        const rawStream = createPushableRawStream([
            bytes(
                ...startCode(), 0x67, 0x64, 0x00, 0x1f,
                ...startCode(), 0x68, 0xeb, 0xec,
                ...startCode(), 0x65, 0x80, 0x84,
                ...startCode(), 0x41, 0x80, 0x9a,
                ...startCode(), 0x65, 0x80, 0x85,
            ),
        ]);
        const stopServer = vi.fn(async () => ({ status: 'stopped' as const, diagnostics: [] }));
        const receipts: unknown[] = [];
        const adapter = mod.createAndroidScrcpyServerCaptureAdapter({
            serial: 'emulator-5554',
            sourceId: 'simulator:android:emulator-5554:screen',
            ensureServer: async () => ({
                ok: true,
                handle: {
                    state: {
                        serial: 'emulator-5554',
                        artifact: {
                            path: '/tmp/scrcpy-server.jar',
                            version: '3.2',
                            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                        remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
                        transportStatus: 'running',
                    },
                    readState: () => ({
                        serial: 'emulator-5554',
                        artifact: {
                            path: '/tmp/scrcpy-server.jar',
                            version: '3.2',
                            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                        remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
                        transportStatus: 'running',
                    }),
                    rawVideoStream: rawStream.stream,
                    stop: stopServer,
                },
            }),
        });

        const result = await adapter.start(startInput({
            emitReceipt: (receipt) => receipts.push(receipt),
        }));

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('expected capture start');

        rawStream.close();

        await vi.waitFor(() => {
            expect(receipts).toEqual([expect.objectContaining({
                id: 'peer.stream.paused',
                reasonCode: 'android_scrcpy_raw_stream_ended',
            })]);
        });
        expect(stopServer).toHaveBeenCalledTimes(1);
        expect(result.session.applySidebandControl?.({
            v: 1,
            streamId: 'stream_android',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event_keyframe',
            kind: 'request_keyframe',
        })).toEqual({ ok: false, reasonCode: 'capture_stopped' });
    });

    it('fails startup when the raw stream ends before a first frame', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyRawStreamFrameProducer');
        if (!('createAndroidScrcpyRawStreamFrameProducer' in mod)) return;

        const producer = mod.createAndroidScrcpyRawStreamFrameProducer({
            rawStream: rawChunks([]),
        });

        await expect(producer.start({
            sourceId: 'simulator:android:emulator-5554:screen',
            streamId: 'stream_android',
            negotiatedCodecId: 'h264.avcc',
            caps,
            startRequest: startRequest(),
            emitFrame: vi.fn(),
            fail: vi.fn(),
        })).rejects.toMatchObject({
            reasonCode: 'android_scrcpy_raw_stream_ended',
        });
    });

    it('starts scrcpy lazily and feeds its raw stream through the capture adapter', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyServerCaptureAdapter');
        if (!('createAndroidScrcpyServerCaptureAdapter' in mod)) return;

        const stopServer = vi.fn(async () => ({
            status: 'stopped' as const,
            diagnostics: [],
        }));
        const ensureServer = vi.fn(async (): Promise<AndroidScrcpyServerHandleResult> => ({
            ok: true,
            handle: {
                state: {
                    serial: 'emulator-5554',
                    artifact: {
                        path: '/tmp/scrcpy-server.jar',
                        version: '3.2',
                        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                    remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
                    transportStatus: 'running',
                },
                readState: () => ({
                    serial: 'emulator-5554',
                    artifact: {
                        path: '/tmp/scrcpy-server.jar',
                        version: '3.2',
                        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    },
                    remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
                    transportStatus: 'running',
                }),
                rawVideoStream: rawChunks([
                    bytes(
                        ...startCode(), 0x67, 0x64, 0x00, 0x1f,
                        ...startCode(), 0x68, 0xeb, 0xec,
                        ...startCode(), 0x65, 0x80, 0x84,
                        ...startCode(), 0x41, 0x80, 0x9a,
                        ...startCode(), 0x65, 0x80, 0x85,
                    ),
                ]),
                stop: stopServer,
            },
        }));
        const offeredFrames: MachineLiveStreamFrameV1[] = [];
        const adapter = mod.createAndroidScrcpyServerCaptureAdapter({
            serial: 'emulator-5554',
            sourceId: 'simulator:android:emulator-5554:screen',
            ensureServer,
        });

        const result = await adapter.start(startInput({
            offerFrame: (frame) => {
                offeredFrames.push(frame);
                return { ok: true };
            },
        }));

        expect(result).toMatchObject({ ok: true });
        expect(ensureServer).toHaveBeenCalledWith({ serial: 'emulator-5554' });
        expect(offeredFrames).toHaveLength(2);
        expect(offeredFrames.map((frame) => frame.codecId)).toEqual(['h264.avcc', 'h264.avcc']);
        if (result.ok) {
            await result.session.stop();
            await result.session.stop();
        }
        expect(stopServer).toHaveBeenCalledTimes(1);
    });

    it('fails closed when scrcpy starts without exposing a raw video stream', async () => {
        const mod = await import('./capture').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidScrcpyServerCaptureAdapter');
        if (!('createAndroidScrcpyServerCaptureAdapter' in mod)) return;

        const stopServer = vi.fn(async () => ({
            status: 'stopped' as const,
            diagnostics: [],
        }));
        const adapter = mod.createAndroidScrcpyServerCaptureAdapter({
            serial: 'emulator-5554',
            sourceId: 'simulator:android:emulator-5554:screen',
            ensureServer: async () => ({
                ok: true,
                handle: {
                    state: {
                        serial: 'emulator-5554',
                        artifact: {
                            path: '/tmp/scrcpy-server.jar',
                            version: '3.2',
                            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                        remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
                        transportStatus: 'running',
                    },
                    readState: () => ({
                        serial: 'emulator-5554',
                        artifact: {
                            path: '/tmp/scrcpy-server.jar',
                            version: '3.2',
                            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                        remotePath: '/data/local/tmp/happier/scrcpy-server.jar',
                        transportStatus: 'running',
                    }),
                    stop: stopServer,
                },
            }),
        });

        await expect(adapter.start(startInput())).resolves.toMatchObject({
            ok: false,
            reasonCode: 'android_scrcpy_raw_stream_unavailable',
        });
        expect(stopServer).toHaveBeenCalledTimes(1);
    });
});
