import { describe, expect, it, vi } from 'vitest';

import { resolveNativeSileroVadBridge } from './NativeSileroVadBridge';

describe('resolveNativeSileroVadBridge frame-fed VAD', () => {
    it('feeds the shared host capture into Sherpa without starting a second recorder', async () => {
        let onFrame: ((frame: Readonly<{
            pcm16leBase64: string;
            sampleRate: number;
            channels: number;
        }>) => void) | null = null;
        const releaseCapture = vi.fn(async () => {});
        const frameSource = {
            acquire: vi.fn(async (request: Readonly<{
                onFrame: typeof onFrame;
            }>) => {
                onFrame = request.onFrame;
                return { release: releaseCapture };
            }),
        };
        const createVadDetector = vi.fn(async () => {});
        const pushVadAudioFrame = vi
            .fn()
            .mockResolvedValueOnce({ speechStarted: true, speechEnded: false })
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true });
        const cancelVadDetector = vi.fn(async () => {});
        const onSpeechStart = vi.fn();
        const onSpeechEnd = vi.fn();
        const nativeModule = {
            createVadDetector,
            pushVadAudioFrame,
            cancelVadDetector,
        };

        const bridge = await resolveNativeSileroVadBridge(nativeModule, { frameSource });
        const session = await bridge!.startSession({
            minSpeechMs: 120,
            redemptionMs: 400,
            sessionId: 'session-a',
            onSpeechStart,
            onSpeechEnd,
        });

        expect(createVadDetector).toHaveBeenCalledWith({
            detectorId: expect.any(String),
            minSpeechMs: 120,
            redemptionMs: 400,
            sampleRate: 16_000,
        });
        expect(frameSource.acquire).toHaveBeenCalledWith(expect.objectContaining({
            ownerId: expect.stringContaining('session-a'),
            format: { sampleRate: 16_000, channels: 1, frameMs: 20 },
            audioSession: {
                mode: 'conversation',
                input: true,
                output: true,
                aec: 'required',
            },
        }));

        onFrame!({ pcm16leBase64: 'AAE=', sampleRate: 16_000, channels: 1 });
        await vi.waitFor(() => expect(pushVadAudioFrame).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(onSpeechStart).toHaveBeenCalledTimes(1));

        onFrame!({ pcm16leBase64: 'AgM=', sampleRate: 16_000, channels: 1 });
        await vi.waitFor(() => expect(pushVadAudioFrame).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(onSpeechEnd).toHaveBeenCalledTimes(1));

        await session.stop();
        await session.stop();
        expect(releaseCapture).toHaveBeenCalledTimes(1);
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(nativeModule).not.toHaveProperty('startVadSession');
    });

    it('unwinds a created detector when shared capture acquisition fails', async () => {
        const cancelVadDetector = vi.fn(async () => {});
        const nativeModule = {
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })),
            cancelVadDetector,
        };
        const bridge = await resolveNativeSileroVadBridge(nativeModule, {
            frameSource: {
                acquire: vi.fn(async () => {
                    throw new Error('capture_failed');
                }),
            },
        });

        await expect(bridge!.startSession({
            minSpeechMs: 0,
            redemptionMs: 0,
            sessionId: 'session-b',
            onSpeechEnd: vi.fn(),
        })).rejects.toThrow('capture_failed');
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
    });

    it('tears down the detector when shared capture reports a terminal error', async () => {
        type CaptureErrorHandler = (error: unknown) => void;

        let onCaptureError: CaptureErrorHandler | null = null;
        const releaseCapture = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const frameSource = {
            acquire: vi.fn(async (request: Readonly<{
                onError?: CaptureErrorHandler;
            }>) => {
                onCaptureError = request.onError ?? null;
                return { release: releaseCapture };
            }),
        };
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })),
            cancelVadDetector,
        }, { frameSource });

        const session = await bridge!.startSession({
            minSpeechMs: 120,
            redemptionMs: 400,
            sessionId: 'session-terminal',
            onSpeechEnd: vi.fn(),
        });

        expect(onCaptureError).toEqual(expect.any(Function));
        onCaptureError!(new Error('native_pcm_capture_dead_object'));

        await vi.waitFor(() => expect(releaseCapture).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(cancelVadDetector).toHaveBeenCalledTimes(1));
        await session.stop();
        expect(releaseCapture).toHaveBeenCalledTimes(1);
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
    });
});
