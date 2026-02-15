import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import {
    daemonVoiceAgentCancelTurnStream,
    createdAudioPlayers,
    daemonVoiceAgentReadTurnStream,
    daemonVoiceAgentSendTurn,
    daemonVoiceAgentStart,
    daemonVoiceAgentStartTurnStream,
    expoSpeechSpeak,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    routerNavigate,
    setActiveServerAndSwitch,
    sessionExecutionRunStart,
    sendMessage,
} from './localVoiceEngine.testHarness';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

describe('local voice engine agent behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('agent mode (openai_compat) chats without persisting to the session when no tool actions are emitted', async () => {
        const { useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore');

        useVoiceActivityStore.setState((state) => ({ ...state, eventsBySessionId: {} }));

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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                baseUrl: 'http://localhost:8001',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Voice agent reply' } }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        for (let i = 0; i < 2000 && (globalThis.fetch as any).mock.calls.length < 3; i++) {
            await Promise.resolve();
        }
        for (let i = 0; i < 2000 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(sendMessage).not.toHaveBeenCalled();

        const events = (useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? []) as any[];
        expect(events.some((e) => e.kind === 'user.text' && String(e.text).includes('hello world'))).toBe(true);
        expect(events.some((e) => e.kind === 'assistant.text' && String(e.text).includes('Voice agent reply'))).toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/chat/completions');
    });

    it('agent mode (openai_compat) sends a session message when the voice agent emits sendSessionMessage', async () => {
        const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
        useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');

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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                baseUrl: 'http://localhost:8001',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        const actionBlock = [
            '<voice_actions>',
            JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'Please do X.' } }] }),
            '</voice_actions>',
        ].join('\n');

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: `Voice agent reply\n\n${actionBlock}` } }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        for (let i = 0; i < 2000 && (globalThis.fetch as any).mock.calls.length < 3; i++) {
            await Promise.resolve();
        }
        for (let i = 0; i < 2000 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(sendMessage).toHaveBeenCalledWith('s1', 'Please do X.');
    });

    it('agent mode can update tracked sessions via tool actions', async () => {
        const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
        useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
        useVoiceTargetStore.getState().setTrackedSessionIds([]);

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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
                s2: { id: 's2', metadata: { path: '/tmp2', host: 'test' } },
            },
        });

        const actionBlock = [
            '<voice_actions>',
            JSON.stringify({ actions: [{ t: 'setTrackedSessions', args: { sessionIds: ['s1', 's2'] } }] }),
            '</voice_actions>',
        ].join('\n');

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: `Voice agent reply\n\n${actionBlock}` } }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Done.' } }] }),
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        expect(useVoiceTargetStore.getState().trackedSessionIds).toEqual(['s1', 's2']);

        const chatCalls = (globalThis.fetch as any).mock.calls.filter((call: any[]) => String(call?.[0] ?? '').includes('/chat/completions'));
        const hasToolResultsMessage = chatCalls.some((call: any[]) => {
            const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
            const messages = Array.isArray(body?.messages) ? body.messages : [];
            return messages.some((m: any) => typeof m?.content === 'string' && m.content.includes('VOICE_TOOL_RESULTS_JSON:'));
        });
        expect(hasToolResultsMessage).toBe(true);
    });

    it('agent mode includes buffered context updates in the next turn', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Voice agent reply' } }] }),
            });

        const { toggleLocalVoiceTurn, appendLocalVoiceAgentContextUpdate } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn('s1');
        appendLocalVoiceAgentContextUpdate('s1', 'Session became focused: s1');
        await toggleLocalVoiceTurn('s1');

        const requestBody = (globalThis.fetch as any).mock.calls?.[1]?.[1]?.body;
        expect(String(requestBody)).toContain('Session became focused: s1');
    });

    it('resets to idle with send_failed when agent turn request throws', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                baseUrl: 'http://localhost:8001',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockRejectedValueOnce(new Error('agent turn failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        const nextState = getLocalVoiceState();
        expect(nextState.status).toBe('idle');
        // Keep the session active so the user can retry without re-starting voice.
        expect(nextState.sessionId).toBe('s1');
        expect(nextState.error).toBe('send_failed');
    });

    it('falls back to openai_compat agent when daemon agent is unsupported and openai_compat is configured', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'session-model', metadata: { flavor: 'codex' } },
            },
        });

        const error: any = new Error('unsupported');
        error.rpcErrorCode = 'VOICE_AGENT_UNSUPPORTED';
        daemonVoiceAgentStart.mockRejectedValueOnce(error);

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Voice agent reply' } }] }),
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/chat/completions');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('recreates daemon agent handle when daemon reports VOICE_AGENT_NOT_FOUND', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart
            .mockResolvedValueOnce({ voiceAgentId: 'va1' })
            .mockResolvedValueOnce({ voiceAgentId: 'va2' });
        daemonVoiceAgentSendTurn
            .mockRejectedValueOnce(Object.assign(new Error('not found'), { rpcErrorCode: 'VOICE_AGENT_NOT_FOUND' }))
            .mockResolvedValueOnce({ assistantText: 'Recovered reply' });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(2);
        expect(daemonVoiceAgentSendTurn).toHaveBeenCalledTimes(2);
    });

    it('uses daemon streaming agent methods when streaming is enabled', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: true,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-abc' });
        daemonVoiceAgentReadTurnStream.mockResolvedValueOnce({
            streamId: 'stream-abc',
            events: [{ t: 'done', assistantText: 'streamed reply' }],
            nextCursor: 1,
            done: true,
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentReadTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
    });

    it('falls back to daemon sendTurn when streaming methods are unavailable', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: true,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        daemonVoiceAgentSendTurn.mockResolvedValueOnce({ assistantText: 'fallback reply' });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).toHaveBeenCalledTimes(1);
    });

    it('cancels stream when stream read fails with method-not-found before falling back', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: true,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-1' });
        daemonVoiceAgentReadTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        daemonVoiceAgentSendTurn.mockResolvedValueOnce({ assistantText: 'fallback reply' });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentCancelTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).toHaveBeenCalledTimes(1);
    });

    it('streams agent deltas into chunked device TTS playback when enabled', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: true,
                                ttsEnabled: true,
                                ttsChunkChars: 32,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-tts-1' });
        daemonVoiceAgentReadTurnStream.mockResolvedValueOnce({
            streamId: 'stream-tts-1',
            events: [
                { t: 'delta', textDelta: 'hello world. this is chunk one. ' },
                { t: 'delta', textDelta: 'and this is chunk two with extra words.' },
                { t: 'done', assistantText: 'hello world. this is chunk one. and this is chunk two with extra words.' },
            ],
            nextCursor: 3,
            done: true,
        });
        expoSpeechSpeak.mockImplementation((_text: string, options: any) => {
            options?.onDone?.();
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps single-shot speech playback when streaming speech is disabled', async () => {
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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: true,
                                ttsEnabled: false,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-tts-2' });
        daemonVoiceAgentReadTurnStream.mockResolvedValueOnce({
            streamId: 'stream-tts-2',
            events: [
                { t: 'delta', textDelta: 'hello world. this is chunk one. ' },
                { t: 'delta', textDelta: 'and this is chunk two with extra words.' },
                { t: 'done', assistantText: 'hello world. this is chunk one. and this is chunk two with extra words.' },
            ],
            nextCursor: 3,
            done: true,
        });
        expoSpeechSpeak.mockImplementation((_text: string, options: any) => {
            options?.onDone?.();
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
    });

    it('agent mode (openai_compat) starts a review run when the voice agent emits startReview', async () => {
        const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
        useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
        sessionExecutionRunStart.mockReset();
        sessionExecutionRunStart.mockResolvedValue({ runId: 'run_1', callId: 'c1', sidechainId: 's1' });

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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                baseUrl: 'http://localhost:8001',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        const actionsBlock = [
            '<voice_actions>',
            JSON.stringify({ actions: [{ t: 'startReview', args: { engineIds: ['claude'], instructions: 'Review.', changeType: 'committed', base: { kind: 'none' } } }] }),
            '</voice_actions>',
        ].join('\n');

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: `Ok.\n\n${actionsBlock}` } }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        for (let i = 0; i < 2000 && (globalThis.fetch as any).mock.calls.length < 3; i++) {
            await Promise.resolve();
        }
        for (let i = 0; i < 2000 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(sessionExecutionRunStart).toHaveBeenCalledWith('s1', expect.objectContaining({ intent: 'review', backendId: 'claude' }));
    });

    it('agent mode (openai_compat) opens a session when the voice agent emits openSession', async () => {
        routerNavigate.mockReset();
        setActiveServerAndSwitch.mockReset();
        setActiveServerAndSwitch.mockResolvedValue(true);

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
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.adapters.local_conversation.tts,
                                autoSpeakReplies: true,
                                baseUrl: 'http://localhost:8001',
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'openai_compat',
                                openaiCompat: {
                                    ...storage.getState().settings.voice.adapters.local_conversation.agent.openaiCompat,
                                    chatBaseUrl: 'http://localhost:8002',
                                    chatApiKey: null,
                                    chatModel: 'fast-model',
                                    commitModel: 'commit-model',
                                },
                            },
                        },
                    },
                },
            },
            sessionListViewDataByServerId: {
                ...(storage.getState() as any).sessionListViewDataByServerId,
                'server-b': [
                    {
                        type: 'session',
                        serverId: 'server-b',
                        serverName: 'Server B',
                        session: { id: 's_other', active: false, updatedAt: 10, presence: 'offline', metadata: { path: '/tmp', host: 'b-host' } },
                    },
                ],
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        const actionsBlock = [
            '<voice_actions>',
            JSON.stringify({ actions: [{ t: 'openSession', args: { sessionId: 's_other' } }] }),
            '</voice_actions>',
        ].join('\n');

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: `Ok.\n\n${actionsBlock}` } }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        for (let i = 0; i < 2000 && (globalThis.fetch as any).mock.calls.length < 3; i++) {
            await Promise.resolve();
        }
        for (let i = 0; i < 2000 && createdAudioPlayers.length === 0; i++) {
            await Promise.resolve();
        }
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(setActiveServerAndSwitch).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server-b' }));
        expect(routerNavigate).toHaveBeenCalledWith('/session/s_other', expect.any(Object));
    });
});
