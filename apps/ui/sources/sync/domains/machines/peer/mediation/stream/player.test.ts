import { describe, expect, it } from 'vitest';

const webMjpegCapabilities = {
    platform: 'web',
    renderers: ['mjpeg'],
    supportedCodecs: ['image.mjpeg'],
    degradedReasonCodes: [],
} as const;

const webAvccCapabilities = {
    platform: 'web',
    renderers: ['mjpeg', 'webcodecs'],
    supportedCodecs: ['image.mjpeg', 'h264.avcc'],
    degradedReasonCodes: [],
} as const;

describe('live-stream player state', () => {
    it('chooses the MJPEG baseline when H.264 is unavailable to the viewer', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['h264.avcc', 'image.mjpeg'],
            preferredCodec: 'h264.avcc',
            capabilities: webMjpegCapabilities,
        });

        expect(opened).toMatchObject({
            phase: 'opening',
            selectedCodec: 'image.mjpeg',
            activeRenderer: 'mjpeg',
            diagnostic: { reasonCode: 'preferred_codec_unavailable' },
        });
    });

    it('preserves the last valid frame during reconnect, error, and stopped phases', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['image.mjpeg'],
            preferredCodec: 'image.mjpeg',
            capabilities: webMjpegCapabilities,
        });
        const playing = mod.reduceLiveStreamPlayerState(opened, {
            type: 'frame',
            codecId: 'image.mjpeg',
            frameUrl: 'data:image/jpeg;base64,AQID',
            timestampMs: 1_000,
            bufferedBytes: 0,
            droppedFrames: 0,
        });
        const reconnecting = mod.reduceLiveStreamPlayerState(playing, {
            type: 'reconnecting',
            reasonCode: 'socket_reconnect',
        });
        const errored = mod.reduceLiveStreamPlayerState(reconnecting, {
            type: 'error',
            reasonCode: 'decoder_error',
        });
        const stopped = mod.reduceLiveStreamPlayerState(errored, {
            type: 'stopped',
            reasonCode: 'viewer_closed',
        });

        expect(reconnecting).toMatchObject({
            phase: 'reconnecting',
            lastFrameUrl: 'data:image/jpeg;base64,AQID',
            diagnostic: { reasonCode: 'socket_reconnect' },
        });
        expect(errored).toMatchObject({
            phase: 'error',
            lastFrameUrl: 'data:image/jpeg;base64,AQID',
            diagnostic: { reasonCode: 'decoder_error' },
        });
        expect(stopped).toMatchObject({
            phase: 'stopped',
            lastFrameUrl: 'data:image/jpeg;base64,AQID',
            diagnostic: { reasonCode: 'viewer_closed' },
        });
    });

    it('falls back to MJPEG on H.264 startup timeout when the source supports the baseline', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['h264.avcc', 'image.mjpeg'],
            preferredCodec: 'h264.avcc',
            capabilities: webAvccCapabilities,
        });
        const timedOut = mod.reduceLiveStreamPlayerState(opened, {
            type: 'startup_timeout',
            reasonCode: 'decoder_startup_timeout',
        });

        expect(opened).toMatchObject({
            phase: 'opening',
            selectedCodec: 'h264.avcc',
            activeRenderer: 'webcodecs',
        });
        expect(timedOut).toMatchObject({
            phase: 'degraded',
            selectedCodec: 'image.mjpeg',
            activeRenderer: 'mjpeg',
            diagnostic: { reasonCode: 'decoder_startup_timeout' },
        });
    });

    it('clears stale H.264 frame data when startup fallback switches to an image codec', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['h264.avcc', 'image.mjpeg'],
            preferredCodec: 'h264.avcc',
            capabilities: webAvccCapabilities,
        });
        const h264Frame = mod.reduceLiveStreamPlayerState(opened, {
            type: 'frame',
            codecId: 'h264.avcc',
            frameUrl: 'blob:h264-frame',
            timestampMs: 1_000,
            bufferedBytes: 256,
            droppedFrames: 1,
        });
        const timedOut = mod.reduceLiveStreamPlayerState(h264Frame, {
            type: 'startup_timeout',
            reasonCode: 'decoder_startup_timeout',
        });

        expect(timedOut).toMatchObject({
            phase: 'degraded',
            selectedCodec: 'image.mjpeg',
            activeRenderer: 'mjpeg',
            decodedFrames: 0,
            droppedFrames: 0,
            bufferedBytes: 0,
            diagnostic: { reasonCode: 'decoder_startup_timeout' },
        });
        expect(timedOut.lastFrameUrl).toBeUndefined();
        expect(timedOut.lastFrameAtMs).toBeUndefined();
    });

    it('falls back to single image frames on H.264 startup timeout when MJPEG is unavailable', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['h264.avcc', 'image.frame.v1'],
            preferredCodec: 'h264.avcc',
            capabilities: {
                platform: 'web',
                renderers: ['mjpeg', 'webcodecs'],
                supportedCodecs: ['image.frame.v1', 'image.mjpeg', 'h264.avcc'],
                degradedReasonCodes: [],
            },
        });
        const timedOut = mod.reduceLiveStreamPlayerState(opened, {
            type: 'startup_timeout',
            reasonCode: 'decoder_startup_timeout',
        });

        expect(timedOut).toMatchObject({
            phase: 'degraded',
            selectedCodec: 'image.frame.v1',
            activeRenderer: 'mjpeg',
            diagnostic: { reasonCode: 'decoder_startup_timeout' },
        });
    });

    it('clears stale frames and counters when opening a new stream', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['image.mjpeg'],
            preferredCodec: 'image.mjpeg',
            capabilities: webMjpegCapabilities,
        });
        const playing = mod.reduceLiveStreamPlayerState(opened, {
            type: 'frame',
            codecId: 'image.mjpeg',
            frameUrl: 'data:image/jpeg;base64,OLD=',
            timestampMs: 1_000,
            bufferedBytes: 10,
            droppedFrames: 2,
        });
        const reopened = mod.reduceLiveStreamPlayerState(playing, {
            type: 'open',
            sourceCodecs: ['image.mjpeg'],
            preferredCodec: 'image.mjpeg',
            capabilities: webMjpegCapabilities,
        });

        expect(reopened).toMatchObject({
            phase: 'opening',
            decodedFrames: 0,
            droppedFrames: 0,
            bufferedBytes: 0,
        });
        expect(reopened.lastFrameUrl).toBeUndefined();
        expect(reopened.lastFrameAtMs).toBeUndefined();
    });

    it('drops frames that do not match the selected codec after fallback', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['h264.avcc', 'image.mjpeg'],
            preferredCodec: 'h264.avcc',
            capabilities: webAvccCapabilities,
        });
        const timedOut = mod.reduceLiveStreamPlayerState(opened, {
            type: 'startup_timeout',
            reasonCode: 'decoder_startup_timeout',
        });
        const lateH264 = mod.reduceLiveStreamPlayerState(timedOut, {
            type: 'frame',
            codecId: 'h264.avcc',
            frameUrl: 'blob:late-h264',
            timestampMs: 1_100,
            bufferedBytes: 128,
            droppedFrames: 0,
        });

        expect(lateH264).toMatchObject({
            phase: 'degraded',
            selectedCodec: 'image.mjpeg',
            activeRenderer: 'mjpeg',
            decodedFrames: 0,
            droppedFrames: 1,
            diagnostic: { reasonCode: 'codec_frame_mismatch' },
        });
        expect(lateH264.lastFrameUrl).toBeUndefined();
    });

    it('records decoder reconfiguration without blanking the render surface', async () => {
        const mod = await import('./player').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceLiveStreamPlayerState');
        expect(mod).toHaveProperty('initialLiveStreamPlayerState');
        if (!('reduceLiveStreamPlayerState' in mod) || !('initialLiveStreamPlayerState' in mod)) return;

        const opened = mod.reduceLiveStreamPlayerState(mod.initialLiveStreamPlayerState, {
            type: 'open',
            sourceCodecs: ['h264.avcc', 'image.mjpeg'],
            preferredCodec: 'h264.avcc',
            capabilities: webAvccCapabilities,
        });
        const playing = mod.reduceLiveStreamPlayerState(opened, {
            type: 'frame',
            codecId: 'h264.avcc',
            frameUrl: 'blob:frame-1',
            timestampMs: 1_000,
            bufferedBytes: 256,
            droppedFrames: 0,
        });
        const reconfigured = mod.reduceLiveStreamPlayerState(playing, {
            type: 'decoder_reconfigured',
            width: 390,
            height: 844,
            orientation: 'portrait',
        });

        expect(reconfigured).toMatchObject({
            phase: 'playing',
            lastFrameUrl: 'blob:frame-1',
            renderEvent: {
                type: 'decoderReconfigured',
                width: 390,
                height: 844,
                orientation: 'portrait',
            },
        });
    });
});
