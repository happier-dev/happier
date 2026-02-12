import { describe, expect, it, vi } from 'vitest';

import {
    createdAudioPlayers,
    daemonMediatorStart,
    deleteAsync,
    expoSpeechSpeak,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
    setPlatformOs,
} from './localVoiceEngine.testHarness';

describe('local voice engine TTS behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('auto-speaks the next assistant message when enabled and configured', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
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

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        const stopPromise = toggleLocalVoiceTurn('s1');
        for (let i = 0; i < 200 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/audio/speech');
    });

    it('auto-speaks via device TTS when enabled (no endpoint required)', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalAutoSpeakReplies: true,
                voiceLocalUseDeviceTts: true,
                voiceLocalTtsBaseUrl: null,
            },
        });

        let onDone: null | (() => void) = null;
        expoSpeechSpeak.mockImplementationOnce((_text: string, opts: any) => {
            onDone = typeof opts?.onDone === 'function' ? opts.onDone : null;
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');

        let resolved = false;
        const stopPromise = toggleLocalVoiceTurn('s1');
        stopPromise.then(() => {
            resolved = true;
        });

        // Wait for speech to start.
        for (let i = 0; i < 200 && getLocalVoiceState().status !== 'speaking'; i++) {
            await Promise.resolve();
        }
        expect(getLocalVoiceState().status).toBe('speaking');
        expect(expoSpeechSpeak).toHaveBeenCalled();

        // Should not resolve until onDone fires.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(resolved).toBe(false);

        if (onDone === null) throw new Error('expected expo-speech onDone callback');
        onDone();
        await stopPromise;

        // Only STT fetch; no /v1/audio/speech call.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('waits for TTS playback to finish before returning to idle', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');

        let resolved = false;
        const stopPromise = toggleLocalVoiceTurn('s1');
        stopPromise.then(() => {
            resolved = true;
        });

        for (let i = 0; i < 200 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        expect(getLocalVoiceState().status).toBe('speaking');

        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(resolved).toBe(false);

        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;
        expect(getLocalVoiceState().status).toBe('idle');
    });

    it('cleans up native TTS temp files when playback finishes', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
                voiceLocalConversationMode: 'mediator',
                voiceLocalMediatorBackend: 'daemon',
            },
        });

        daemonMediatorStart.mockResolvedValueOnce({
            mediatorId: 'm1',
            effective: { chatModelId: 'default', commitModelId: 'default', permissionPolicy: 'read_only' },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        const stopPromise = toggleLocalVoiceTurn('s1');

        for (let i = 0; i < 200 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(deleteAsync).toHaveBeenCalled();
    });

    it('does not auto-speak when sending fails', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
            },
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        sendMessage.mockRejectedValueOnce(new Error('send failed'));

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('send failed');

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('auto-speaks the next assistant message even when server timestamps are behind local time', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
            },
            sessionMessages: {
                s1: {
                    messages: [{ id: 'baseline', kind: 'agent-text', text: 'old', createdAt: Date.now() }],
                },
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        sendMessage.mockImplementationOnce(() => {
            storage.__setState({
                sessionMessages: {
                    s1: {
                        messages: [
                            { id: 'baseline', kind: 'agent-text', text: 'old', createdAt: Date.now() },
                            { id: 'm_new', kind: 'agent-text', text: 'New assistant', createdAt: Date.now() - 60_000 },
                        ],
                    },
                },
            });
            storage.__notify();
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        const stopPromise = toggleLocalVoiceTurn('s1');
        for (let i = 0; i < 200 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/audio/speech');
    });

    it('does not hang when assistant polling throws; resolves to idle', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalConversationMode: 'direct_session',
                voiceLocalAutoSpeakReplies: true,
            },
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        sendMessage.mockImplementationOnce(() => {
            storage.__throwGetStateOnce(new Error('boom'));
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
    });

    it('revokes web TTS blob URLs when playback finishes', async () => {
        setPlatformOs('web');
        const originalCreate = (URL as any).createObjectURL;
        const originalRevoke = (URL as any).revokeObjectURL;

        (URL as any).createObjectURL = vi.fn(() => 'blob:tts-url');
        (URL as any).revokeObjectURL = vi.fn();

        try {
            const storage = await getStorage();
            storage.__setState({
                settings: {
                    ...storage.getState().settings,
                    voiceLocalConversationMode: 'direct_session',
                    voiceLocalAutoSpeakReplies: true,
                    voiceLocalTtsBaseUrl: 'http://localhost:8001',
                },
                sessionMessages: {},
            });

            (globalThis.fetch as any)
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ text: 'hello world' }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
                });

            sendMessage.mockImplementationOnce(() => {
                storage.__setState({
                    sessionMessages: {
                        s1: {
                            messages: [{ id: 'm_web_1', kind: 'agent-text', text: 'Hi there', createdAt: Date.now() + 60_000 }],
                        },
                    },
                });
                storage.__notify();
            });

            const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
            await toggleLocalVoiceTurn('s1');
            const stopPromise = toggleLocalVoiceTurn('s1');

            for (let i = 0; i < 200 && createdAudioPlayers.length === 0; i++) {
                await Promise.resolve();
            }
            expect((URL as any).createObjectURL).toHaveBeenCalledTimes(1);
            expect(createdAudioPlayers.length).toBe(1);

            createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
            await stopPromise;
            expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:tts-url');
        } finally {
            (URL as any).createObjectURL = originalCreate;
            (URL as any).revokeObjectURL = originalRevoke;
        }
    });
});
