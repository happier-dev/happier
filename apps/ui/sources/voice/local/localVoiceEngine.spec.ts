import { describe, expect, it } from 'vitest';

import {
    daemonMediatorStart,
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
        expect(getLocalVoiceState().status).toBe('idle');
    });

    it('mediator mode (daemon) resolves chat/commit models from settings sources', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalSttBaseUrl: 'http://localhost:8000',
                voiceLocalConversationMode: 'mediator',
                voiceLocalMediatorBackend: 'daemon',
                voiceMediatorChatModelSource: 'session',
                voiceMediatorChatModelId: 'ignored',
                voiceMediatorCommitModelSource: 'custom',
                voiceMediatorCommitModelId: 'commit-model',
                voiceLocalAutoSpeakReplies: false,
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', modelMode: 'session-model', metadata: { flavor: 'claude' } },
            },
        });

        daemonMediatorStart.mockResolvedValueOnce({
            mediatorId: 'm1',
            effective: { chatModelId: 'session-model', commitModelId: 'commit-model', permissionPolicy: 'read_only' },
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonMediatorStart).toHaveBeenCalledTimes(1);
        const startArgs = (daemonMediatorStart as any).mock.calls?.[0]?.[0];
        expect(startArgs.chatModelId).toBe('session-model');
        expect(startArgs.commitModelId).toBe('commit-model');
    });
});
