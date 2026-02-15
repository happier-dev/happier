import { describe, expect, it, vi } from 'vitest';

import {
    createdAudioPlayers,
    daemonVoiceAgentStart,
    deleteAsync,
    expoSpeechSpeak,
    expoSpeechStop,
    emitSpeechRecEvent,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
    speechRecStart,
    setPlatformOs,
} from './localVoiceEngine.testHarness';

describe('local voice engine TTS behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('auto-speaks the next assistant message when enabled and configured', async () => {
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
                                provider: 'device',
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
        expoSpeechSpeak.mockImplementationOnce((_text: string, opts: any) => {
            onDoneRef.current = typeof opts?.onDone === 'function' ? (opts.onDone as () => void) : undefined;
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

        if (!onDoneRef.current) {
            throw new Error('Expected Expo Speech onDone callback');
        }
        onDoneRef.current();
        await stopPromise;

        // Only STT fetch; no /v1/audio/speech call.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first turn', confidence: 0.9, segments: [] }] });
        const sendTurnPromise = toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('end', {});

        for (let i = 0; i < 200 && getLocalVoiceState().status !== 'speaking'; i += 1) {
            await Promise.resolve();
        }
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

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first turn', confidence: 0.9, segments: [] }] });
        const sendTurnPromise = toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('end', {});

        for (let i = 0; i < 200 && getLocalVoiceState().status !== 'speaking'; i += 1) {
            await Promise.resolve();
        }
        expect(getLocalVoiceState().status).toBe('speaking');

        await toggleLocalVoiceTurn('s1');

        expect(expoSpeechStop).not.toHaveBeenCalled();
        expect(speechRecStart).toHaveBeenCalledTimes(1);
        expect(getLocalVoiceState().status).toBe('speaking');

        onDoneRef.current?.();
        await sendTurnPromise;
    });

    it('waits for TTS playback to finish before returning to idle', async () => {
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
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_conversation: {
                            ...storage.getState().settings.voice.adapters.local_conversation,
                            conversationMode: 'agent',
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                provider: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.tts.openaiCompat,
                                    baseUrl: 'http://localhost:8001',
                                },
                            },
                        },
                    },
                },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({
            voiceAgentId: 'va1',
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
