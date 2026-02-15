import { describe, expect, it } from 'vitest';

import {
    daemonVoiceAgentStart,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
} from './localVoiceEngine.testHarness';

describe('local voice engine (turn-based) smoke', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('records then transcribes and sends a message on stop', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        await toggleLocalVoiceTurn('s1');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith('s1', 'hello world');
        // After a turn completes, the local voice session remains active (ready for another turn)
        // until the user explicitly hangs up.
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('agent mode (daemon) resolves chat/commit models from settings sources', async () => {
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
                                chatModelSource: 'session',
                                chatModelId: 'ignored',
                                commitModelSource: 'custom',
                                commitModelId: 'commit-model',
                            },
                        },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'session-model', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({
            voiceAgentId: 'va1',
            effective: { chatModelId: 'session-model', commitModelId: 'commit-model', permissionPolicy: 'read_only' },
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(1);
        const startArgs = (daemonVoiceAgentStart as any).mock.calls?.[0]?.[0];
        expect(startArgs.chatModelId).toBe('session-model');
        expect(startArgs.commitModelId).toBe('commit-model');
    });

    it('does not start a local voice turn while realtime voice is connected', async () => {
        const storage = await getStorage();
        storage.__setState({ realtimeStatus: 'connected' });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');

        // Local voice should not start recording while a realtime call is active.
        expect(getLocalVoiceState().status).toBe('idle');
    });
});
