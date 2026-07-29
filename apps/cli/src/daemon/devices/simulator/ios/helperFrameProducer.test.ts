import { describe, expect, it, vi } from 'vitest';

import type { SimulatorCaptureFrameProducerStartInput } from '../capture/adapter';
import type { IosSimulatorHelperFrameMessage } from './helperProtocol';

describe('iOS simulator helper frame producer', () => {
    function startInput(overrides: Partial<SimulatorCaptureFrameProducerStartInput> = {}): SimulatorCaptureFrameProducerStartInput {
        return {
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            streamId: 'stream-1',
            negotiatedCodecId: 'image.mjpeg',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 30,
                maxFrameBytes: 8_192,
                maxDurationMs: 60_000,
            },
            startRequest: {
                v: 1,
                streamId: 'stream-1',
                streamFamily: 'ios-simulator:A1B2-C3D4:screen',
                routeKind: 'loopback_direct',
                sourceMachineId: 'source-machine',
                targetMachineId: 'target-machine',
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 30,
                maxFrameBytes: 8_192,
                maxDurationMs: 60_000,
            },
            emitFrame: () => undefined,
            fail: () => undefined,
            ...overrides,
        };
    }

    it('turns helper frame messages into capture adapter frames', async () => {
        const { createIosSimulatorHelperFrameProducer } = await import('./helperFrameProducer');
        const frames: unknown[] = [];
        let emitHelperMessage: (message: IosSimulatorHelperFrameMessage) => void = () => {};
        const producer = createIosSimulatorHelperFrameProducer({
            openStream: async ({ emitMessage }) => {
                emitHelperMessage = emitMessage;
                return { stop: () => undefined };
            },
        });

        await expect(producer.start(startInput({
            emitFrame: (frame) => frames.push(frame),
        }))).resolves.toMatchObject({
            stop: expect.any(Function),
        });

        emitHelperMessage({
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 1,
            timestampMs: 1_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: Buffer.from([1, 2, 3]).toString('base64'),
            payloadSizeBytes: 3,
        });

        expect(frames).toEqual([{
            codecId: 'image.mjpeg',
            frame: {
                v: 1,
                timestampMs: 1_000,
                payloadKind: 'image_keyframe',
                payloadEncoding: 'binary_base64',
                payloadBase64: 'AQID',
                payloadSizeBytes: 3,
            },
        }]);
    });

    it('does not run a second sequence parser after the session boundary has emitted typed frames', async () => {
        const { createIosSimulatorHelperFrameProducer } = await import('./helperFrameProducer');
        const frames: unknown[] = [];
        const fail = vi.fn();
        let emitHelperMessage: (message: IosSimulatorHelperFrameMessage) => void = () => {};
        const producer = createIosSimulatorHelperFrameProducer({
            openStream: async ({ emitMessage }) => {
                emitHelperMessage = emitMessage;
                return { stop: () => undefined };
            },
        });

        await producer.start(startInput({
            emitFrame: (frame) => frames.push(frame),
            fail,
        }));

        emitHelperMessage({
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 2,
            timestampMs: 2_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: Buffer.from([1, 2, 3]).toString('base64'),
            payloadSizeBytes: 3,
        });
        emitHelperMessage({
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 1,
            timestampMs: 1_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: Buffer.from([1, 2, 3]).toString('base64'),
            payloadSizeBytes: 3,
        });

        expect(fail).not.toHaveBeenCalled();
        expect(frames).toHaveLength(2);
    });

    it('reports helper stream mismatch through the producer fatal path', async () => {
        const { createIosSimulatorHelperFrameProducer } = await import('./helperFrameProducer');
        const stop = vi.fn();
        const fail = vi.fn();
        let emitHelperMessage: (message: IosSimulatorHelperFrameMessage) => void = () => {};
        const producer = createIosSimulatorHelperFrameProducer({
            openStream: async ({ emitMessage }) => {
                emitHelperMessage = emitMessage;
                return { stop };
            },
        });

        await producer.start(startInput({ fail }));

        emitHelperMessage({
            v: 1,
            kind: 'frame',
            streamId: 'wrong-stream',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 1,
            timestampMs: 1_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: Buffer.from([1, 2, 3]).toString('base64'),
            payloadSizeBytes: 3,
        });

        expect(fail).toHaveBeenCalledWith('ios_helper_frame_stream_mismatch');
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
