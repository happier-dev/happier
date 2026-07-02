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

    it('falls back to MJPEG when AVCC produces no startup frame', async () => {
        const mod = await import('./codecs').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('reduceMachineLiveStreamAvccFallbackState');
        expect(mod).toHaveProperty('initialMachineLiveStreamAvccFallbackState');
        if (
            !('reduceMachineLiveStreamAvccFallbackState' in mod)
            || !('initialMachineLiveStreamAvccFallbackState' in mod)
        ) return;

        const timedOut = mod.reduceMachineLiveStreamAvccFallbackState(
            mod.initialMachineLiveStreamAvccFallbackState,
            { type: 'startup_timeout' },
        );
        expect(timedOut).toEqual({ streamed: false, fellBackToMjpeg: true });

        const withFrame = mod.reduceMachineLiveStreamAvccFallbackState(
            mod.initialMachineLiveStreamAvccFallbackState,
            { type: 'frame' },
        );
        expect(mod.reduceMachineLiveStreamAvccFallbackState(withFrame, { type: 'startup_timeout' })).toEqual({
            streamed: true,
            fellBackToMjpeg: false,
        });

        expect(mod.reduceMachineLiveStreamAvccFallbackState(timedOut, { type: 'reset' })).toEqual(
            mod.initialMachineLiveStreamAvccFallbackState,
        );
    });
});
