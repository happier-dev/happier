import { describe, expect, it, vi } from 'vitest';

import {
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    setNextRecorderPrepareError,
} from './localVoiceEngine.testHarness';

describe('local voice engine recording lifecycle', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('cleans up and reports an error when recording initialization fails', async () => {
        setNextRecorderPrepareError(new Error('prepare failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('prepare failed');
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('recording_start_failed');
    });

    it('throws when STT base URL is missing', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_conversation: {
                            ...storage.getState().settings.voice.adapters.local_conversation,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: '',
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('missing_stt_base_url');

        expect(globalThis.fetch).toHaveBeenCalledTimes(0);
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('missing_stt_base_url');
    });

    it('resets to idle when STT request throws (network error)', async () => {
        (globalThis.fetch as any).mockRejectedValueOnce(new Error('network down'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_failed');
    });

    it('times out STT request and resets to idle', async () => {
        vi.useFakeTimers();
        try {
            const storage = await getStorage();
            storage.__setState({
                settings: {
                    ...storage.getState().settings,
                    voice: {
                        ...storage.getState().settings.voice,
                        adapters: {
                            ...storage.getState().settings.voice.adapters,
                            local_conversation: {
                                ...storage.getState().settings.voice.adapters.local_conversation,
                                networkTimeoutMs: 1000,
                            },
                        },
                    },
                },
            });

            (globalThis.fetch as any).mockImplementationOnce((_url: string, init?: RequestInit) => {
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (!signal) return;
                    signal.addEventListener(
                        'abort',
                        () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
                        { once: true },
                    );
                });
            });

            const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
            await toggleLocalVoiceTurn('s1');

            const stopPromise = toggleLocalVoiceTurn('s1');
            await vi.advanceTimersByTimeAsync(1001);
            await expect(stopPromise).resolves.toBeUndefined();

            expect(getLocalVoiceState().status).toBe('idle');
            expect(getLocalVoiceState().error).toBe('stt_failed');
        } finally {
            vi.useRealTimers();
        }
    });
});
