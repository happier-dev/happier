import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const micVadNew = vi.fn();
const micVadStart = vi.fn();
const micVadPause = vi.fn();
let activeOnSpeechEnd: (() => void) | null = null;

vi.mock('@ricky0123/vad-web', () => ({
    MicVAD: {
        new: (...args: unknown[]) => micVadNew(...args),
    },
}));

describe('createWebVadController', () => {
    const previousWindow = (globalThis as { window?: object }).window;
    const previousDocument = (globalThis as { document?: object }).document;

    beforeEach(() => {
        micVadNew.mockReset();
        micVadStart.mockReset();
        micVadPause.mockReset();
        activeOnSpeechEnd = null;
        (globalThis as { window?: object }).window = {};
        (globalThis as { document?: object }).document = {};
        micVadNew.mockImplementation(async (options: { onSpeechEnd?: () => void }) => {
            activeOnSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
            return {
                start: micVadStart,
                pause: micVadPause,
            };
        });
    });

    afterEach(() => {
        if (previousWindow === undefined) {
            Reflect.deleteProperty(globalThis as object, 'window');
        } else {
            (globalThis as { window?: object }).window = previousWindow;
        }

        if (previousDocument === undefined) {
            Reflect.deleteProperty(globalThis as object, 'document');
        } else {
            (globalThis as { document?: object }).document = previousDocument;
        }
    });

    it('starts a web VAD session and emits runtime-owned web_vad endpoint signals', async () => {
        const onEndpointSignal = vi.fn();
        const { createWebVadController } = await import('./WebVadController');

        const controller = createWebVadController({
            onEndpointSignal,
        });

        await expect(controller.startSession({
            minSpeechMs: 120,
            redemptionMs: 450,
            sessionId: 'session-web',
        })).resolves.toBe(true);

        expect(micVadNew).toHaveBeenCalledWith(expect.objectContaining({
            minSpeechMs: 120,
            model: 'v5',
            redemptionMs: 450,
        }));
        expect(micVadStart).toHaveBeenCalledTimes(1);

        activeOnSpeechEnd?.();

        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-web',
            source: 'web_vad',
            transcript: '',
        }));
    });

    it('returns false when the web VAD runtime cannot start', async () => {
        micVadNew.mockRejectedValueOnce(new Error('vad unavailable'));
        const onEndpointSignal = vi.fn();
        const { createWebVadController } = await import('./WebVadController');

        const controller = createWebVadController({
            onEndpointSignal,
        });

        await expect(controller.startSession({
            minSpeechMs: 120,
            redemptionMs: 450,
            sessionId: 'session-web',
        })).resolves.toBe(false);

        expect(onEndpointSignal).not.toHaveBeenCalled();
    });
});
