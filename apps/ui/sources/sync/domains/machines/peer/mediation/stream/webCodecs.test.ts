import { describe, expect, it, vi } from 'vitest';

import { createBrowserLiveStreamWebCodecsAdapter } from './webCodecs';

describe('browser WebCodecs stream adapter', () => {
    it('resolves decode only after an output frame is delivered', async () => {
        let output: ((frame: { close?: () => void }) => void) | null = null;
        const getOutput = (): (frame: { close?: () => void }) => void => {
            if (!output) throw new Error('expected decoder output callback');
            return output;
        };
        const closeFrame = vi.fn();
        class FakeVideoDecoder {
            constructor(init: { output: (frame: { close?: () => void }) => void }) {
                output = init.output;
            }
            configure(): void {}
            decode(): void {}
            close(): void {}
        }
        class FakeEncodedVideoChunk {
            constructor(_init: unknown) {}
        }

        const adapter = createBrowserLiveStreamWebCodecsAdapter({
            scope: {
                VideoDecoder: FakeVideoDecoder,
                EncodedVideoChunk: FakeEncodedVideoChunk,
            },
        });

        await adapter.configure({ description: new Uint8Array([1, 0x64, 0, 0x28]) });
        let resolved = false;
        const decodePromise = adapter.decode({
            type: 'keyframe',
            payload: new Uint8Array([0x65, 1]),
        }).then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(resolved).toBe(false);

        getOutput()({ close: closeFrame });
        await decodePromise;

        expect(resolved).toBe(true);
        expect(closeFrame).toHaveBeenCalledTimes(1);
    });

    it('rejects pending decode when the browser decoder reports an async error', async () => {
        let rejectDecode: ((error: unknown) => void) | null = null;
        const getRejectDecode = (): (error: unknown) => void => {
            if (!rejectDecode) throw new Error('expected decoder error callback');
            return rejectDecode;
        };
        class FakeVideoDecoder {
            constructor(init: { error: (error: unknown) => void }) {
                rejectDecode = init.error;
            }
            configure(): void {}
            decode(): void {}
            close(): void {}
        }
        class FakeEncodedVideoChunk {
            constructor(_init: unknown) {}
        }

        const adapter = createBrowserLiveStreamWebCodecsAdapter({
            scope: {
                VideoDecoder: FakeVideoDecoder,
                EncodedVideoChunk: FakeEncodedVideoChunk,
            },
        });

        await adapter.configure({ description: new Uint8Array([1, 0x64, 0, 0x28]) });
        const decodePromise = adapter.decode({
            type: 'keyframe',
            payload: new Uint8Array([0x65, 1]),
        });
        getRejectDecode()(new Error('decoder failed'));

        await expect(decodePromise).rejects.toThrow(/webcodecs_decoder_error/u);
    });
});
