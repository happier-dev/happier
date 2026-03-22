import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import {
    daemonVoiceAgentCancelTurnStream,
    createdAudioPlayers,
    daemonVoiceAgentReadTurnStream,
    daemonVoiceAgentSendTurn,
    daemonVoiceAgentStart,
    daemonVoiceAgentStartTurnStream,
    daemonVoiceAgentWelcome,
    expoSpeechSpeak,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    routerNavigate,
    sessionRpcWithServerScope,
    setActiveServerAndSwitch,
    sessionExecutionRunStart,
    sendMessage,
} from './localVoiceEngine.testHarness';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import type { VoiceAgentClient } from '@/voice/agent/types';

type VoiceAgentTurnStreamReadResult = Awaited<ReturnType<VoiceAgentClient['readTurnStream']>>;

type MockWithCalls = {
    mock: {
        calls: unknown[][];
    };
};

async function waitForCondition(check: () => boolean, timeoutMessage: string) {
    for (let i = 0; i < 4000; i++) {
        if (check()) return;
        await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${timeoutMessage}`);
}

async function waitForMockCalls(mock: MockWithCalls, expectedCount: number) {
    await waitForCondition(() => mock.mock.calls.length >= expectedCount, `mock call count ${expectedCount}`);
}

async function flushMicrotasks(iterations: number) {
    for (let i = 0; i < iterations; i++) {
        await Promise.resolve();
    }
}

async function waitForCreatedAudioPlayerListener(eventName: string) {
    await waitForCondition(() => createdAudioPlayers[0]?.__hasListener?.(eventName) === true, `audio player listener: ${eventName}`);
}

async function waitForCreatedAudioPlayer() {
    await waitForCondition(() => createdAudioPlayers.length > 0, 'created audio player');
}

let localVoiceEngine: typeof import('./localVoiceEngine');
let useVoiceActivityStore: typeof import('@/voice/activity/voiceActivityStore').useVoiceActivityStore;
let useVoiceTargetStore: typeof import('@/voice/runtime/voiceTargetStore').useVoiceTargetStore;

describe('local voice engine agent behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    beforeEach(async () => {
        ({ useVoiceActivityStore } = await import('@/voice/activity/voiceActivityStore'));
        ({ useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore'));
        localVoiceEngine = await import('./localVoiceEngine');
    }, 180_000);

    it('agent mode (openai_compat) chats without persisting to the session when no tool actions are emitted', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        const fetchMock = globalThis.fetch as unknown as MockWithCalls;
        await waitForMockCalls(fetchMock, 3);
        await waitForCreatedAudioPlayer();
        expect(createdAudioPlayers.length).toBeGreaterThan(0);
        await waitForCreatedAudioPlayerListener('playbackStatusUpdate');
        createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
        await stopPromise;

        expect(sendMessage).not.toHaveBeenCalled();

        const events = (useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? []) as any[];
        expect(events.some((e) => e.kind === 'user.text' && String(e.text).includes('hello world'))).toBe(true);
        expect(events.some((e) => e.kind === 'assistant.text' && String(e.text).includes('Voice agent reply'))).toBe(true);
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/chat/completions');
    }, 60_000);

    it('agent mode (openai_compat) sends a session message when the voice agent emits sendSessionMessage', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
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
                json: async () => ({ choices: [{ message: { content: 'Done.' } }] }),
            });

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        const fetchMock = globalThis.fetch as unknown as MockWithCalls;
        await waitForMockCalls(fetchMock, 3);
        await stopPromise;

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[0]).toBe('s1');
        expect(sendMessage.mock.calls[0]?.[1]).toBe('Please do X.');
    });

    it('agent mode can update tracked sessions via tool actions', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;

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

    it('agent mode can update tracked sessions from a comma-separated voice action list', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
                s2: { id: 's2', metadata: { path: '/tmp2', host: 'test' } },
            },
        });

        const actionBlock = [
            '<voice_actions>',
            JSON.stringify({ actions: [{ t: 'setTrackedSessions', args: { sessionIds: 's1, s2' } }] }),
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        expect(useVoiceTargetStore.getState().trackedSessionIds).toEqual(['s1', 's2']);
    });

    it('agent mode can answer structured user-action requests through the shared voice tool handlers', async () => {
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
                s1: {
                    id: 's1',
                    active: true,
                    presence: 'online',
                    metadata: { path: '/tmp', host: 'test' },
                    agentState: {
                        requests: {
                            req_question: {
                                id: 'req_question',
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                            },
                        },
                    },
                },
            },
        });

        const actionBlock = [
            '<voice_actions>',
            JSON.stringify({
                actions: [
                    {
                        t: 'answerUserActionRequest',
                        args: {
                            answers: [{ question: 'Continue?', answer: 'Yes' }],
                        },
                    },
                ],
            }),
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        expect(sessionRpcWithServerScope).toHaveBeenCalledWith({
            sessionId: 's1',
            method: 'permission',
            payload: { id: 'req_question', approved: true, answers: { 'Continue?': 'Yes' } },
        });

        const chatCalls = (globalThis.fetch as any).mock.calls.filter((call: any[]) => String(call?.[0] ?? '').includes('/chat/completions'));
        const toolResultsCarrier = chatCalls
            .map((call: any[]) => JSON.parse(String(call?.[1]?.body ?? '{}')))
            .flatMap((body: any) => (Array.isArray(body?.messages) ? body.messages : []))
            .find(
                (message: any) =>
                    message?.role === 'user' &&
                    typeof message?.content === 'string' &&
                    message.content.startsWith('VOICE_TOOL_RESULTS_JSON:'),
            );

        expect(toolResultsCarrier?.content).toContain('"t":"answerUserActionRequest"');
        expect(toolResultsCarrier?.content).toContain('"ok":true');
    });

    it('agent mode tells the model not to claim success when a voice tool result reports an error', async () => {
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
                s1: {
                    id: 's1',
                    active: true,
                    presence: 'online',
                    metadata: { path: '/tmp', host: 'test' },
                    agentState: {
                        requests: {},
                    },
                },
            },
        });

        const actionBlock = [
            '<voice_actions>',
            JSON.stringify({
                actions: [
                    {
                        t: 'answerUserActionRequest',
                        args: {
                            answers: [{ question: 'Continue?', answer: 'Yes' }],
                        },
                    },
                ],
            }),
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
                json: async () => ({ choices: [{ message: { content: 'Understood.' } }] }),
            });

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        const chatCalls = (globalThis.fetch as any).mock.calls.filter((call: any[]) => String(call?.[0] ?? '').includes('/chat/completions'));
        const toolResultsCarrier = chatCalls
            .map((call: any[]) => JSON.parse(String(call?.[1]?.body ?? '{}')))
            .flatMap((body: any) => (Array.isArray(body?.messages) ? body.messages : []))
            .find(
                (message: any) =>
                    message?.role === 'user' &&
                    typeof message?.content === 'string' &&
                    message.content.startsWith('VOICE_TOOL_RESULTS_JSON:'),
            );

        expect(toolResultsCarrier?.content).toContain('"errorCode":"no_permission_request"');
        expect(toolResultsCarrier?.content).toContain('Do not claim success');
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
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

        const { toggleLocalVoiceTurn, appendLocalVoiceAgentContextUpdate } = localVoiceEngine;

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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
            },
        });

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockRejectedValueOnce(new Error('agent turn failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'session-model', metadata: { flavor: 'claude' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentReadTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
    });

    it('prewarmOnConnect starts the daemon voice agent when recording begins (before STT completes)', async () => {
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
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: false,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await flushMicrotasks(4000);

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(1);
    });

    it('suppresses expected daemon-unavailable prewarm errors while still starting the local recording flow', async () => {
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
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.adapters.local_conversation.streaming,
                                enabled: false,
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        const consoleErrorSpy = vi.fn();
        console.error = consoleErrorSpy as any;
        daemonVoiceAgentStart.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await flushMicrotasks(4000);

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it('welcome (immediate) triggers a daemon welcome action during prewarm on connect', async () => {
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
                                provider: 'device',
                                autoSpeakReplies: true,
                            },
                            agent: {
                                ...storage.getState().settings.voice.adapters.local_conversation.agent,
                                backend: 'daemon',
                                prewarmOnConnect: true,
                                welcome: { enabled: true, mode: 'immediate', templateId: null },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentWelcome.mockResolvedValueOnce({ assistantText: 'Welcome!' });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await waitForMockCalls(daemonVoiceAgentWelcome, 1);

        expect(daemonVoiceAgentWelcome).toHaveBeenCalledTimes(1);
        await waitForMockCalls(expoSpeechSpeak, 1);
        expect(expoSpeechSpeak).toHaveBeenCalled();
    });

    it('resetLocalVoiceAgentPersistence clears persisted run metadata and global voice activity', async () => {
        useVoiceActivityStore.setState((state) => ({
            ...state,
            eventsBySessionId: {
                ...state.eventsBySessionId,
                [VOICE_AGENT_GLOBAL_SESSION_ID]: [{ id: 'e1', ts: 1, sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, adapterId: 'local_conversation', kind: 'user.text', text: 'hi' } as any],
            },
        }));

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
                                prewarmOnConnect: true,
                                transcript: { persistenceMode: 'persistent', epoch: 1 },
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                sys_voice: {
                    id: 'sys_voice',
                    modelMode: 'default',
                    metadata: {
                        flavor: 'claude',
                        systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
                        voiceAgentRunV1: { v: 1, runId: 'run_prev', backendId: 'claude', resumeHandle: null, updatedAtMs: 1 },
                    },
                },
            },
            sessionMessages: {
                sys_voice: { isLoaded: true, messages: [] },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        const { toggleLocalVoiceTurn, resetLocalVoiceAgentPersistence } = localVoiceEngine;
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        await flushMicrotasks(4000);

        await resetLocalVoiceAgentPersistence();

        expect((storage.getState() as any).sessions.sys_voice.metadata.voiceAgentRunV1).toBeNull();
        expect((useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID] ?? []).length).toBe(0);
    });

    it('surfaces send_failed when daemon streaming start is unavailable', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: 's1',
            error: 'send_failed',
        });
    });

    it('cancels the stream and surfaces send_failed when daemon streaming read is unavailable', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-1' });
        daemonVoiceAgentReadTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(daemonVoiceAgentCancelTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: 's1',
            error: 'send_failed',
        });
    });

    it('interrupts an in-flight local agent text update and surfaces the follow-up assistant reply', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        let resolveFirstRead: (value: VoiceAgentTurnStreamReadResult) => void = () => {
            throw new Error('Expected first stream read resolver');
        };
        const firstReadPromise = new Promise<VoiceAgentTurnStreamReadResult>((resolve) => {
            resolveFirstRead = resolve;
        });
        daemonVoiceAgentStartTurnStream
            .mockResolvedValueOnce({ streamId: 'stream-1' })
            .mockResolvedValueOnce({ streamId: 'stream-2' });
        daemonVoiceAgentReadTurnStream.mockImplementation(async ({ streamId }: any) => {
            if (streamId === 'stream-1') {
                return await firstReadPromise;
            }
            return {
                streamId,
                events: [{ t: 'done', assistantText: 'Permission summary', actions: [] }],
                nextCursor: 1,
                done: true,
            };
        });

        const { sendLocalVoiceAgentTextUpdate } = localVoiceEngine;

        const first = sendLocalVoiceAgentTextUpdate('s1', 'Initial coding request');
        await waitForMockCalls(daemonVoiceAgentStartTurnStream, 1);

        const second = sendLocalVoiceAgentTextUpdate('s1', 'Permission required. Ask the human whether to allow it.');
        await waitForMockCalls(daemonVoiceAgentCancelTurnStream, 1);

        resolveFirstRead({
            streamId: 'stream-1',
            events: [],
            nextCursor: 0,
            done: false,
        });

        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();

        expect(daemonVoiceAgentCancelTurnStream).toHaveBeenCalledWith({
            sessionId: 's1',
            streamId: 'stream-1',
            voiceAgentId: 'va1',
        });
        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(2);

        const events = (useVoiceActivityStore.getState().eventsBySessionId['s1'] ?? []) as any[];
        expect(events.some((event) => event.kind === 'assistant.text' && String(event.text).includes('Permission summary'))).toBe(true);
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;
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
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
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

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
    });

    it('agent mode (openai_compat) starts a review run when the voice agent emits startReview', async () => {
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
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
                json: async () => ({ choices: [{ message: { content: 'Review started.' } }] }),
            });

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        const fetchMock = globalThis.fetch as unknown as MockWithCalls;
        await waitForMockCalls(fetchMock, 3);
        await stopPromise;

        expect(sessionExecutionRunStart).toHaveBeenCalledWith(
            's1',
            expect.objectContaining({
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                intentInput: expect.objectContaining({ engineId: 'claude' }),
            }),
        );
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
                s1: { id: 's1', active: true, presence: 'online', metadata: { path: '/tmp', host: 'test' } },
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
                json: async () => ({ choices: [{ message: { content: 'Opened session.' } }] }),
            });

        const { toggleLocalVoiceTurn } = localVoiceEngine;

        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        const fetchMock = globalThis.fetch as unknown as MockWithCalls;
        await waitForMockCalls(fetchMock, 3);
        await stopPromise;

        expect(setActiveServerAndSwitch).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server-b' }));
        expect(routerNavigate).toHaveBeenCalledWith('/session/s_other', expect.any(Object));
    });
});
