import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const micVadNew = vi.fn();
const micVadStart = vi.fn();
const micVadPause = vi.fn();
let activeOnSpeechEnd: (() => void) | null = null;
let activeOnSpeechStart: (() => void) | null = null;

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
        activeOnSpeechStart = null;
        (globalThis as { window?: object }).window = {};
        (globalThis as { document?: object }).document = {};
        micVadNew.mockImplementation(async (options: { onSpeechEnd?: () => void; onSpeechStart?: () => void }) => {
            activeOnSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
            activeOnSpeechStart = typeof options.onSpeechStart === 'function' ? options.onSpeechStart : null;
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
        const { createWebVadController } = await import('./WebVadController.web');

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

    it('consumes the canonical mic session stream and shared AudioContext instead of self-acquiring', async () => {
        const onEndpointSignal = vi.fn();
        const sharedStream = { id: 'shared' } as unknown as MediaStream;
        const sharedAudioContext = { state: 'running' } as unknown as AudioContext;
        const ensureActive = vi.fn(async () => {});
        const micSession = {
            ensureActive,
            setMuted: vi.fn(),
            isMuted: vi.fn(() => false),
            teardown: vi.fn(async () => {}),
            getStream: vi.fn(() => sharedStream),
            getAudioContext: vi.fn(() => sharedAudioContext),
        };

        const { createWebVadController } = await import('./WebVadController.web');
        const controller = createWebVadController({ onEndpointSignal });

        await expect(controller.startSession({
            minSpeechMs: 120,
            redemptionMs: 450,
            sessionId: 'session-shared',
            micSession: micSession as never,
        })).resolves.toBe(true);

        const options = micVadNew.mock.calls[0]?.[0] as {
            audioContext?: AudioContext;
            getStream?: () => Promise<MediaStream>;
            pauseStream?: (stream: MediaStream) => Promise<void>;
            resumeStream?: (stream: MediaStream) => Promise<MediaStream>;
        };
        expect(options.audioContext).toBe(sharedAudioContext);
        expect(typeof options.getStream).toBe('function');
        expect(typeof options.pauseStream).toBe('function');
        expect(typeof options.resumeStream).toBe('function');

        await expect(options.getStream?.()).resolves.toBe(sharedStream);
        expect(ensureActive).toHaveBeenCalled();
        // pauseStream must NOT stop the shared stream.
        await expect(options.pauseStream?.(sharedStream)).resolves.toBeUndefined();
    });

    it('applies the two-stage confirmMs false-start debounce: a sub-confirmMs speech segment is suppressed', async () => {
        const onEndpointSignal = vi.fn();
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
        let clock = 0;
        const { createWebVadController } = await import('./WebVadController.web');

        const controller = createWebVadController({
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
            now: () => clock,
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
        });

        await expect(controller.startSession({
            minSpeechMs: 0,
            redemptionMs: 0,
            sessionId: 'session-web',
        })).resolves.toBe(true);

        // Speech starts at t=0, the VAD declares speech-end at t=300 (< confirmMs).
        clock = 0;
        activeOnSpeechStart?.();
        clock = 300;
        activeOnSpeechEnd?.();
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(onSpeechCandidateStart).toHaveBeenCalledWith({ sessionId: 'session-web', source: 'web_vad' });
        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledWith({ sessionId: 'session-web', source: 'web_vad' });

        // A subsequent sustained segment (> confirmMs) still emits.
        clock = 1_000;
        activeOnSpeechStart?.();
        clock = 2_000;
        activeOnSpeechEnd?.();
        expect(onEndpointSignal).toHaveBeenCalledTimes(1);
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-web',
            source: 'web_vad',
        }));
        expect(onSpeechCandidateStart).toHaveBeenCalledTimes(2);
        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledTimes(1);
    });

    it('emits a web_vad endpoint without a speech-start edge (no regression for start-less VADs)', async () => {
        const onEndpointSignal = vi.fn();
        const { createWebVadController } = await import('./WebVadController.web');

        const controller = createWebVadController({
            onEndpointSignal,
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
        });

        await expect(controller.startSession({
            minSpeechMs: 0,
            redemptionMs: 0,
            sessionId: 'session-web',
        })).resolves.toBe(true);

        // No onSpeechStart fired; the endpoint must still pass through.
        activeOnSpeechEnd?.();
        expect(onEndpointSignal).toHaveBeenCalledTimes(1);
    });

    it('returns false when the web VAD runtime cannot start', async () => {
        micVadNew.mockRejectedValueOnce(new Error('vad unavailable'));
        const onEndpointSignal = vi.fn();
        const { createWebVadController } = await import('./WebVadController.web');

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
