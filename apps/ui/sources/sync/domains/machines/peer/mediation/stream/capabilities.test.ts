import { describe, expect, it } from 'vitest';

describe('live-stream viewer capabilities', () => {
    it('advertises WebCodecs H.264 support when the product renderer is available', async () => {
        const mod = await import('./capabilities').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('resolveLiveStreamViewerCapabilities');
        if (!('resolveLiveStreamViewerCapabilities' in mod)) return;

        expect(mod.resolveLiveStreamViewerCapabilities({
            platform: 'web',
            renderers: {
                mjpeg: true,
                webcodecs: true,
                mse: false,
                wasm: false,
                nativeVideo: false,
            },
            policy: {
                allowMse: false,
                allowWasm: false,
            },
        })).toEqual({
            platform: 'web',
            renderers: ['mjpeg', 'webcodecs'],
            supportedCodecs: ['image.frame.v1', 'image.mjpeg', 'h264.avcc'],
            degradedReasonCodes: [],
        });
    });

    it('keeps the explicit MJPEG baseline on native when native video decode is unavailable', async () => {
        const mod = await import('./capabilities').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('resolveLiveStreamViewerCapabilities');
        if (!('resolveLiveStreamViewerCapabilities' in mod)) return;

        expect(mod.resolveLiveStreamViewerCapabilities({
            platform: 'native',
            renderers: {
                mjpeg: true,
                webcodecs: false,
                mse: false,
                wasm: false,
                nativeVideo: false,
            },
            policy: {
                allowMse: false,
                allowWasm: false,
            },
        })).toEqual({
            platform: 'native',
            renderers: ['mjpeg'],
            supportedCodecs: ['image.frame.v1', 'image.mjpeg'],
            degradedReasonCodes: ['native_video_unavailable'],
        });
    });

    it('advertises single image-frame support through the same explicit image renderer path', async () => {
        const mod = await import('./capabilities').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('resolveLiveStreamViewerCapabilities');
        if (!('resolveLiveStreamViewerCapabilities' in mod)) return;

        expect(mod.resolveLiveStreamViewerCapabilities({
            platform: 'web',
            renderers: {
                mjpeg: true,
                webcodecs: false,
                mse: false,
                wasm: false,
                nativeVideo: false,
            },
        }).supportedCodecs).toEqual(['image.frame.v1', 'image.mjpeg']);
    });
});
