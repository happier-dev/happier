import { describe, expect, it } from 'vitest';

import type {
    MachineLiveStreamFrameV1,
    MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol';

import { resolveLiveStreamViewerCapabilities } from '@/sync/domains/machines/peer/mediation/stream';

import {
    createSimulatorRelayStreamState,
    mapSimulatorRelayEnvelopeToIngestionEvent,
    reduceSimulatorRelayStreamState,
    toSimulatorPreviewStreamState,
    type SimulatorRelayStreamState,
} from './streamState';

const STREAM_ID = 'stream_1';
const SOURCE = 'machine_source';
const TARGET = 'machine_target';

const webViewerCapabilities = resolveLiveStreamViewerCapabilities({
    platform: 'web',
    renderers: { mjpeg: true, webcodecs: true, mse: false, wasm: false, nativeVideo: false },
});

function imageFrame(sequence: number): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: STREAM_ID,
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
    };
}

function h264Frame(sequence: number): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: STREAM_ID,
        sequence,
        timestampMs: 2_000 + sequence,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AAAABWEAAAAB',
        payloadSizeBytes: 9,
        codecId: 'h264.avcc',
    } as MachineLiveStreamFrameV1;
}

function openState(preferredCodec?: 'h264.avcc' | 'image.mjpeg'): SimulatorRelayStreamState {
    return reduceSimulatorRelayStreamState(createSimulatorRelayStreamState(STREAM_ID), {
        type: 'open',
        sourceCodecs: ['h264.avcc', 'image.mjpeg'],
        capabilities: webViewerCapabilities,
        ...(preferredCodec ? { preferredCodec } : {}),
    });
}

describe('reduceSimulatorRelayStreamState', () => {
    it('feeds an MJPEG frame to the decoder as a data URL the player can render', () => {
        const state = reduceSimulatorRelayStreamState(openState('image.mjpeg'), {
            type: 'frame',
            frame: imageFrame(1),
        });
        const stream = toSimulatorPreviewStreamState(state);
        expect(stream.phase).toBe('playing');
        expect(stream.selectedCodec).toBe('image.mjpeg');
        expect(stream.activeRenderer).toBe('mjpeg');
        expect(stream.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
        expect(stream.avccChunks).toBeUndefined();
        expect(stream.decodedFrames).toBe(1);
    });

    it('feeds an H.264 frame to the WebCodecs decoder as AVCC chunks (no data URL)', () => {
        const state = reduceSimulatorRelayStreamState(openState('h264.avcc'), {
            type: 'frame',
            frame: h264Frame(1),
        });
        const stream = toSimulatorPreviewStreamState(state);
        expect(stream.phase).toBe('playing');
        expect(stream.selectedCodec).toBe('h264.avcc');
        expect(stream.activeRenderer).toBe('webcodecs');
        expect(stream.lastFrameUrl).toBeUndefined();
        expect(stream.avccChunks?.length).toBe(1);
        expect(stream.decodedFrames).toBe(1);
    });

    it('preserves the last MJPEG frame across a reconnect', () => {
        const streaming = reduceSimulatorRelayStreamState(openState('image.mjpeg'), {
            type: 'frame',
            frame: imageFrame(1),
        });
        const reconnecting = reduceSimulatorRelayStreamState(streaming, {
            type: 'reconnecting',
            reasonCode: 'socket_disconnected',
        });
        const stream = toSimulatorPreviewStreamState(reconnecting);
        expect(stream.phase).toBe('reconnecting');
        expect(stream.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
        expect(stream.diagnostic?.reasonCode).toBe('socket_disconnected');
    });

    it('marks the stream stopped while retaining the last frame', () => {
        const streaming = reduceSimulatorRelayStreamState(openState('image.mjpeg'), {
            type: 'frame',
            frame: imageFrame(1),
        });
        const stopped = reduceSimulatorRelayStreamState(streaming, { type: 'stopped', reasonCode: 'stream_closed' });
        const stream = toSimulatorPreviewStreamState(stopped);
        expect(stream.phase).toBe('stopped');
        expect(stream.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
    });
});

describe('mapSimulatorRelayEnvelopeToIngestionEvent', () => {
    function envelope(message: MachineLiveStreamRelayEnvelopeV1['message']): MachineLiveStreamRelayEnvelopeV1 {
        return { v: 1, sourceMachineId: SOURCE, targetMachineId: TARGET, message };
    }

    it('maps a matching frame envelope to a frame event', () => {
        const event = mapSimulatorRelayEnvelopeToIngestionEvent({
            envelope: envelope({ kind: 'frame', frame: imageFrame(1) }),
            sourceMachineId: SOURCE,
            targetMachineId: TARGET,
            streamId: STREAM_ID,
        });
        expect(event).toEqual({ type: 'frame', frame: imageFrame(1) });
    });

    it('ignores envelopes addressed to a different machine', () => {
        const event = mapSimulatorRelayEnvelopeToIngestionEvent({
            envelope: envelope({ kind: 'frame', frame: imageFrame(1) }),
            sourceMachineId: SOURCE,
            targetMachineId: 'other_target',
            streamId: STREAM_ID,
        });
        expect(event).toBeNull();
    });

    it('ignores frames for a different stream', () => {
        const event = mapSimulatorRelayEnvelopeToIngestionEvent({
            envelope: envelope({ kind: 'frame', frame: { ...imageFrame(1), streamId: 'other_stream' } }),
            sourceMachineId: SOURCE,
            targetMachineId: TARGET,
            streamId: STREAM_ID,
        });
        expect(event).toBeNull();
    });

    it('maps a stop control to a stopped event', () => {
        const event = mapSimulatorRelayEnvelopeToIngestionEvent({
            envelope: envelope({ kind: 'control', control: { v: 1, streamId: STREAM_ID, kind: 'stop', reasonCode: 'done' } }),
            sourceMachineId: SOURCE,
            targetMachineId: TARGET,
            streamId: STREAM_ID,
        });
        expect(event).toEqual({ type: 'stopped', reasonCode: 'done' });
    });

    it('maps a rejected start_response to an error event', () => {
        const event = mapSimulatorRelayEnvelopeToIngestionEvent({
            envelope: envelope({
                kind: 'start_response',
                startResponse: { v: 1, streamId: STREAM_ID, accepted: false, disabledReason: 'server_relay_disabled' },
            }),
            sourceMachineId: SOURCE,
            targetMachineId: TARGET,
            streamId: STREAM_ID,
        });
        expect(event).toEqual({ type: 'error', reasonCode: 'server_relay_disabled' });
    });
});
