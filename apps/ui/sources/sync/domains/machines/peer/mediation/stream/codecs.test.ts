import { describe, expect, it } from 'vitest';

describe('machine live-stream codec preference', () => {
    it('falls back to the baseline image codec when H.264 is unavailable', async () => {
        const mod = await import('./codecs').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('resolveMachineLiveStreamCodecPreference');
        if (!('resolveMachineLiveStreamCodecPreference' in mod)) return;

        expect(mod.resolveMachineLiveStreamCodecPreference({
            sourceCodecs: ['image.mjpeg'],
            viewerCodecs: ['image.mjpeg', 'h264.avcc'],
            preferredCodec: 'h264.avcc',
        })).toEqual({
            ok: true,
            codecId: 'image.mjpeg',
            fallbackReason: 'preferred_codec_unavailable',
        });
    });

});
