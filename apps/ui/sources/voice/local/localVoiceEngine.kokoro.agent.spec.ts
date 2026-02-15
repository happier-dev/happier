import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  synthesizeKokoroWav: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  prepareKokoroTts: vi.fn(async () => {}),
}));

import {
  createdAudioPlayers,
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  setPlatformOs,
} from './localVoiceEngine.testHarness';

describe('local voice engine agent behavior (kokoro)', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('agent mode auto-speaks via Kokoro provider when enabled', async () => {
    setPlatformOs('web');
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
                provider: 'local_neural',
                openaiCompat: {
                  ...storage.getState().settings.voice.adapters.local_conversation.tts.openaiCompat,
                  baseUrl: null,
                },
                localNeural: {
                  ...storage.getState().settings.voice.adapters.local_conversation.tts.localNeural,
                  model: 'kokoro',
                  voiceId: 'af_heart',
                  speed: 1,
                },
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

    const { toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    for (let i = 0; i < 2000 && createdAudioPlayers.length === 0; i++) {
      await Promise.resolve();
    }
    expect(createdAudioPlayers.length).toBeGreaterThan(0);
    createdAudioPlayers[0].__emit('playbackStatusUpdate', { didJustFinish: true });
    await stopPromise;
  });
});
