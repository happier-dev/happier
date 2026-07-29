import { describe, expect, it, vi } from 'vitest';

import type {
    MachineLiveStreamCapsV1,
    MachineLiveStreamCodecIdV1,
    MachineLiveStreamFrameV1,
    MachineLiveStreamStartRequestV1,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';
import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1 } from '@happier-dev/protocol';
import type { MachineLiveStreamCaptureStartInput } from '../../peer/mediation/stream/captureAdapter';
import type { AndroidScrcpyServerHandleResult } from './android/server';
import type { IosSimulatorHelperFrameMessage } from './ios/helperProtocol';

const caps: MachineLiveStreamCapsV1 = {
    maxBitrateBps: 256_000,
    maxFramesPerSecond: 30,
    maxFrameBytes: 16_384,
    maxDurationMs: 60_000,
    maxTotalBytes: 512_000,
};

const androidResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'android:emulator:emulator-5554',
    platform: 'android',
    deviceId: 'emulator-5554',
    displayName: 'Pixel 9',
    capture: {
        status: 'available',
        sourceId: 'simulator:android:emulator-5554:screen',
        supportedCodecs: ['h264.avcc'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

const iosResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'A1B2-C3D4',
    platform: 'ios',
    deviceId: 'A1B2-C3D4',
    displayName: 'iPhone 16 Pro',
    capture: {
        status: 'available',
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
}

function startCode(): readonly number[] {
    return [0x00, 0x00, 0x01];
}

async function* rawChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) {
        yield chunk;
    }
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
        emitReceipt: () => undefined,
    };
}

describe('createSimulatorCaptureAdapterForResource', () => {
    it('uses the Android scrcpy capture adapter for Android resources', async () => {
        const mod = await import('./captureAdapters').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createSimulatorCaptureAdapterForResource');
        if (!('createSimulatorCaptureAdapterForResource' in mod)) return;

        const stopServer = vi.fn(async () => ({ status: 'stopped' as const, diagnostics: [] }));
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
        const adapter = mod.createSimulatorCaptureAdapterForResource(androidResource, {
            android: { ensureServer },
        });

        const result = await adapter.start(startInput({
            offerFrame: (frame) => {
                offeredFrames.push(frame);
                return { ok: true };
            },
        }));

        expect(result).toMatchObject({ ok: true });
        expect(ensureServer).toHaveBeenCalledWith({ serial: 'emulator-5554' });
        expect(offeredFrames.map((frame) => frame.codecId)).toEqual(['h264.avcc', 'h264.avcc']);
    });

    it('keeps iOS resources fail-closed until the signed helper stream opener exists', async () => {
        const mod = await import('./captureAdapters').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createSimulatorCaptureAdapterForResource');
        if (!('createSimulatorCaptureAdapterForResource' in mod)) return;

        const adapter = mod.createSimulatorCaptureAdapterForResource(iosResource);

        await expect(adapter.start(startInput({
            startRequest: {
                ...startRequest({ preferredCodec: 'image.mjpeg' } as Partial<MachineLiveStreamStartRequestV1>),
                streamId: 'stream_ios',
                streamFamily: 'ios-simulator:A1B2-C3D4:screen',
            },
        }))).resolves.toMatchObject({
            ok: false,
            reasonCode: 'capture_unavailable',
        });
    });

    it('uses the iOS helper frame producer when a helper stream opener is provided', async () => {
        const mod = await import('./captureAdapters').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createSimulatorCaptureAdapterForResource');
        if (!('createSimulatorCaptureAdapterForResource' in mod)) return;

        const stopStream = vi.fn(async () => {});
        const openStream = vi.fn((input: {
            sourceId: string;
            streamId: string;
            codecId: MachineLiveStreamCodecIdV1;
            emitMessage: (message: IosSimulatorHelperFrameMessage) => void;
        }) => {
            input.emitMessage({
                v: 1,
                kind: 'frame',
                streamId: input.streamId,
                sourceId: input.sourceId,
                sequence: 1,
                timestampMs: 1_234,
                codecId: input.codecId,
                payloadKind: 'image_keyframe',
                payloadEncoding: 'binary_base64',
                payloadBase64: 'AQID',
                payloadSizeBytes: 3,
            });
            return { stop: stopStream };
        });
        const options = {
            ios: {
                openStream,
            },
        };
        const offeredFrames: MachineLiveStreamFrameV1[] = [];
        const adapter = mod.createSimulatorCaptureAdapterForResource(iosResource, options);

        const result = await adapter.start(startInput({
            startRequest: {
                ...startRequest({ preferredCodec: 'image.mjpeg' } as Partial<MachineLiveStreamStartRequestV1>),
                streamId: 'stream_ios',
                streamFamily: 'ios-simulator:A1B2-C3D4:screen',
            },
            offerFrame: (frame) => {
                offeredFrames.push(frame);
                return { ok: true };
            },
        }));

        expect(result).toMatchObject({ ok: true });
        expect(openStream).toHaveBeenCalledWith(expect.objectContaining({
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            streamId: 'stream_ios',
            codecId: 'image.mjpeg',
        }));
        expect(offeredFrames).toEqual([expect.objectContaining({
            streamId: 'stream_ios',
            payloadBase64: 'AQID',
            codecId: 'image.mjpeg',
        })]);
    });
});
