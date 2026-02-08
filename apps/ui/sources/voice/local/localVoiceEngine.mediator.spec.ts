import { describe, expect, it } from 'vitest';

import {
    createdAudioPlayers,
    daemonMediatorStart,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
} from './localVoiceEngine.testHarness';

describe('local voice engine mediator behavior', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('mediator mode (openai_compat) chats without persisting to the session until commit', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalSttBaseUrl: 'http://localhost:8000',
                voiceLocalConversationMode: 'mediator',
                voiceLocalMediatorBackend: 'openai_compat',
                voiceLocalChatBaseUrl: 'http://localhost:8002',
                voiceLocalChatApiKey: null,
                voiceLocalChatChatModel: 'fast-model',
                voiceLocalChatCommitModel: 'commit-model',
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
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
                json: async () => ({ choices: [{ message: { content: 'Mediator reply' } }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            });

        const { toggleLocalVoiceTurn, commitLocalVoiceMediator } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn('s1');
        const stopPromise = toggleLocalVoiceTurn('s1');

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
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/chat/completions');

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'Final instruction' } }] }),
        });
        const commit = await commitLocalVoiceMediator('s1');
        expect(commit).toBe('Final instruction');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('mediator mode includes buffered context updates in the next turn', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalSttBaseUrl: 'http://localhost:8000',
                voiceLocalConversationMode: 'mediator',
                voiceLocalMediatorBackend: 'openai_compat',
                voiceLocalChatBaseUrl: 'http://localhost:8002',
                voiceLocalChatApiKey: null,
                voiceLocalChatChatModel: 'fast-model',
                voiceLocalChatCommitModel: 'commit-model',
                voiceLocalAutoSpeakReplies: false,
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
                json: async () => ({ choices: [{ message: { content: 'Mediator reply' } }] }),
            });

        const { toggleLocalVoiceTurn, appendLocalVoiceMediatorContextUpdate } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn('s1');
        appendLocalVoiceMediatorContextUpdate('s1', 'Session became focused: s1');
        await toggleLocalVoiceTurn('s1');

        const requestBody = (globalThis.fetch as any).mock.calls?.[1]?.[1]?.body;
        expect(String(requestBody)).toContain('Session became focused: s1');
    });

    it('resets to idle with send_failed when mediator turn request throws', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalSttBaseUrl: 'http://localhost:8000',
                voiceLocalConversationMode: 'mediator',
                voiceLocalMediatorBackend: 'openai_compat',
                voiceLocalChatBaseUrl: 'http://localhost:8002',
                voiceLocalChatApiKey: null,
                voiceLocalChatChatModel: 'fast-model',
                voiceLocalChatCommitModel: 'commit-model',
                voiceLocalAutoSpeakReplies: true,
                voiceLocalTtsBaseUrl: 'http://localhost:8001',
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
            .mockRejectedValueOnce(new Error('mediator turn failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        const nextState = getLocalVoiceState();
        expect(nextState.status).toBe('idle');
        expect(nextState.sessionId).toBeNull();
        expect(nextState.error).toBe('send_failed');
    });

    it('falls back to openai_compat mediator when daemon mediator is unsupported and openai_compat is configured', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalSttBaseUrl: 'http://localhost:8000',
                voiceLocalConversationMode: 'mediator',
                voiceLocalMediatorBackend: 'daemon',
                voiceLocalChatBaseUrl: 'http://localhost:8002',
                voiceLocalChatApiKey: null,
                voiceLocalChatChatModel: 'fast-model',
                voiceLocalChatCommitModel: 'commit-model',
                voiceLocalAutoSpeakReplies: false,
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'session-model', metadata: { flavor: 'codex' } },
            },
        });

        const error: any = new Error('unsupported');
        error.rpcErrorCode = 'VOICE_MEDIATOR_UNSUPPORTED';
        daemonMediatorStart.mockRejectedValueOnce(error);

        (globalThis.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ text: 'hello world' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'Mediator reply' } }] }),
            });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonMediatorStart).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect((globalThis.fetch as any).mock.calls[1]?.[0]).toContain('/v1/chat/completions');
        expect(sendMessage).not.toHaveBeenCalled();
    });
});
