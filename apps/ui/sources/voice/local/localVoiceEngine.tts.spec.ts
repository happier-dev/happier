import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    expoSpeechSpeak,
    expoSpeechStop,
    emitSpeechRecEvent,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
    speechRecStart,
} from './localVoiceEngine.testHarness';

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;

async function waitForVoiceStatus(getStatus: () => string, expectedStatus: string) {
    await vi.waitFor(() => {
        expect(getStatus()).toBe(expectedStatus);
    });
}

async function expectPromiseToStayPending(promise: Promise<unknown>) {
    await vi.waitFor(async () => {
        const settled = await Promise.race([
            promise.then(() => true),
            new Promise<boolean>((resolve) => {
                setTimeout(() => resolve(false), 0);
            }),
        ]);
        expect(settled).toBe(false);
    });
}

describe('local voice engine TTS behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    it('supports barge-in while device TTS is speaking when enabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                                bargeInEnabled: true,
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_direct.tts.openaiCompat,
                                    baseUrl: null,
                                },
                            },
                        },
                    },
                },
            },
        });

        const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
        const onStoppedRef: { current: (() => void) | undefined } = { current: undefined };
        expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
            onDoneRef.current = typeof opts?.onDone === 'function' ? (opts.onDone as () => void) : undefined;
            onStoppedRef.current = typeof opts?.onStopped === 'function' ? (opts.onStopped as () => void) : undefined;
        });
        expoSpeechStop.mockImplementation(() => {
            onStoppedRef.current?.();
        });

        sendMessage.mockImplementationOnce(() => {
            storage.__setState({
                sessionMessages: {
                    s1: {
                        messages: [{ id: 'm1', kind: 'agent-text', text: 'Hi there', createdAt: Date.now() + 60_000 }],
                    },
                },
            });
            storage.__notify();
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first turn', confidence: 0.9, segments: [] }] });
        const sendTurnPromise = toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('end', {});

        await waitForVoiceStatus(() => getLocalVoiceState().status, 'speaking');
        expect(getLocalVoiceState().status).toBe('speaking');

        await toggleLocalVoiceTurn('s1');
        await sendTurnPromise;

        expect(expoSpeechStop).toHaveBeenCalledTimes(1);
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it('does not interrupt speaking when barge-in is disabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_direct.stt,
                                useDeviceStt: true,
                                baseUrl: null,
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                                bargeInEnabled: false,
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_direct.tts.openaiCompat,
                                    baseUrl: null,
                                },
                            },
                        },
                    },
                },
            },
        });

        const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
        const onStoppedRef: { current: (() => void) | undefined } = { current: undefined };
        expoSpeechSpeak.mockImplementation((_text: string, opts: any) => {
            onDoneRef.current = typeof opts?.onDone === 'function' ? (opts.onDone as () => void) : undefined;
            onStoppedRef.current = typeof opts?.onStopped === 'function' ? (opts.onStopped as () => void) : undefined;
        });
        expoSpeechStop.mockImplementation(() => {
            onStoppedRef.current?.();
        });

        sendMessage.mockImplementationOnce(() => {
            storage.__setState({
                sessionMessages: {
                    s1: {
                        messages: [{ id: 'm1', kind: 'agent-text', text: 'Hi there', createdAt: Date.now() + 60_000 }],
                    },
                },
            });
            storage.__notify();
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first turn', confidence: 0.9, segments: [] }] });
        const sendTurnPromise = toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('end', {});

        await waitForVoiceStatus(() => getLocalVoiceState().status, 'speaking');
        expect(getLocalVoiceState().status).toBe('speaking');

        await toggleLocalVoiceTurn('s1');

        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(speechRecStart).toHaveBeenCalledTimes(1);
        expect(getLocalVoiceState().status).toBe('speaking');

        onDoneRef.current?.();
        await sendTurnPromise;
    });

    it('does not auto-speak when sending fails', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: true,
                                provider: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_direct.tts.openaiCompat,
                                    baseUrl: 'http://localhost:8001',
                                },
                            },
                        },
                    },
                },
            },
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        sendMessage.mockRejectedValueOnce(new Error('send failed'));

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('send failed');

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not hang when assistant polling throws; resolves to idle', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_direct: {
                            ...storage.getState().settings.voice.adapters.local_direct,
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_direct.tts,
                                autoSpeakReplies: true,
                            },
                        },
                    },
                },
            },
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        sendMessage.mockImplementationOnce(() => {
            storage.__throwGetStateOnce(new Error('boom'));
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
    });

});
