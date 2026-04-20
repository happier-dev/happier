import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  streamKokoroWavSentences: () => ({
    async *[Symbol.asyncIterator]() {
      yield { wavBytes: new Uint8Array([1, 2, 3]).buffer, sentenceText: 'hello' };
    },
  }),
  prepareKokoroTts: vi.fn(async () => {}),
}));

import {
  createdAudioPlayers,
  expoSpeechSpeak,
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  setPlatformOs,
} from './localVoiceEngine.testHarness';

let localVoiceEngine: typeof import('./localVoiceEngine');

async function waitForDeviceSpeech() {
  await vi.waitFor(() => {
    expect(expoSpeechSpeak).toHaveBeenCalled();
  });
}

describe('local voice engine agent behavior (kokoro)', () => {
  registerLocalVoiceEngineHarnessHooks();

  beforeEach(async () => {
    localVoiceEngine = await import('./localVoiceEngine');
  }, 180_000);

  it('falls back to device speech when Kokoro runtime is unavailable in the native test harness', async () => {
    setPlatformOs('ios');
    expoSpeechSpeak.mockImplementationOnce((_text: string, options: any) => {
      options?.onStart?.();
      options?.onDone?.();
    });
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
                  execution: 'device',
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

    const { toggleLocalVoiceTurn } = localVoiceEngine;

    await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
    const stopPromise = toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

    await waitForDeviceSpeech();
    expect(createdAudioPlayers.length).toBe(0);
    await stopPromise;
  });
});
