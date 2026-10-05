import { afterAll, beforeEach as beforeAccountCase, afterEach as afterAccountCase } from 'vitest';
import { installLocalVoiceAccountHarness, localVoiceHomeId, warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import {
  daemonVoiceAgentStart,
  daemonVoiceAgentStop,
  emitSpeechRecEvent,
  expoSpeechSpeak,
  expoSpeechStop,
  fileDelete,
  flushMicrotasks,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  localVoicePendingEnqueue,
  registerLocalVoiceEngineHarnessHooks,
  speechRecStart,
  speechRecStop,
} from './localVoiceEngine.testHarness';

const accountHarness = await installLocalVoiceAccountHarness();
const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine stop', () => {
  registerLocalVoiceEngineHarnessHooks();
    beforeAccountCase(async () => {
      await accountHarness.setup();
      const storage = await getStorage();
      // Direct-session submission now reaches real Sync, so its target must
      // exist in the admitting Home rather than only in an old transport stub.
      storage.__setState({ sessions: {
        ...storage.getState().sessions,
        s1: { id: 's1', serverId: localVoiceHomeId, active: true, activeAt: Date.now(), presence: 'online', metadata: { flavor: 'claude' } },
      } });
    });
    afterAccountCase(() => accountHarness.dispose());

  it('stops an in-progress recording turn without sending', async () => {
    const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');

    await stopLocalVoiceSession();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      error: null,
    });
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });

  it('does not send a recorded-audio transcript that resolves after End Voice', async () => {
    const storage = await getStorage();
    let resolveTranscription!: (response: { ok: true; json: () => Promise<{ text: string }> }) => void;
    (globalThis.fetch as any).mockImplementationOnce(() => new Promise((resolve) => {
      resolveTranscription = resolve;
    }));

    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    const stopAndTranscribe = toggleLocalVoiceTurn('s1');
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await vi.waitFor(() => expect(globalThis.fetch, JSON.stringify({
      snapshot: getVoiceConversationRuntimeSnapshot(),
      providerId: storage.getState().settings.voice.providerId,
    })).toHaveBeenCalledOnce());

    await stopLocalVoiceSession();
    resolveTranscription({
      ok: true,
      json: async () => ({ text: 'late transcript' }),
    });
    await stopAndTranscribe;

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it('still releases Local Agent execution and effect custody when finalized-recording cleanup fails during End Voice', async () => {
    const cleanupFailure = new Error('recording_delete_failed');
    daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'voice-agent-end' });
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_conversation',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_conversation: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_conversation.config,
              conversationMode: 'agent',
              stt: {
                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                baseUrl: 'http://localhost:8000',
              },
              agent: {
                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                prewarmOnConnect: true,
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'claude' },
        },
      },
    });
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { voiceCaptureAdmissionController } = await import(
      '@/voice/runtime/input/VoiceCaptureAdmissionController'
    );
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    const { getRetainedLocalVoiceEffectOutcomes } = await import(
      '@/voice/tools/localVoiceEffectOutcomeCustody'
    );
    const {
      getLocalVoiceState,
      isLocalVoiceAgentActive,
      stopLocalVoiceSession,
      toggleLocalVoiceTurn,
    } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(() => expect(daemonVoiceAgentStart, JSON.stringify(getVoiceConversationRuntimeSnapshot())).toHaveBeenCalledOnce());
    await flushMicrotasks(4_000);
    expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
    expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(true);
    getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).set('effect-1', {
      fingerprint: 'effect-fingerprint',
      outcome: Promise.resolve({ t: 'sendSessionMessage', args: {}, result: { ok: true } }),
    });

    fileDelete.mockRejectedValueOnce(cleanupFailure);
    await expect(stopLocalVoiceSession()).rejects.toBe(cleanupFailure);

    expect(fileDelete).toHaveBeenCalledOnce();
    expect(daemonVoiceAgentStop).toHaveBeenCalledOnce();
    expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
    expect(getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).size).toBe(0);
    expect(voiceRuntimeLevelStore.getSnapshot()).toMatchObject({
      inputLevel: 0,
      inputSourceActive: false,
    });
    const dictation = voiceCaptureAdmissionController.acquire('dictation');
    expect(dictation.status).toBe('acquired');
    if (dictation.status === 'acquired') {
      dictation.lease.release();
    }
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      state: 'disconnected',
      micMuted: false,
      error: {
        reason: 'recording_cleanup_failed',
      },
    });
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      error: 'recording_cleanup_failed',
    });
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it('stops device STT recording without sending', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              stt: {
                ...storage.getState().settings.voice.providers.local_direct.config.stt,
                provider: 'device',
              },
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
    });

    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(speechRecStart).toHaveBeenCalledTimes(1);

    const stopPromise = stopLocalVoiceSession();
    expect(speechRecStop).toHaveBeenCalledTimes(1);
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'ending',
      error: null,
    });
    emitSpeechRecEvent('end', {});
    await stopPromise;

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'disconnected',
      error: null,
    });
  });

  it('cancels an in-flight turn through an explicit ending-to-connected transition', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...storage.getState().settings.voice.providers.local_direct.config,
              tts: {
                ...storage.getState().settings.voice.providers.local_direct.config.tts,
                autoSpeakReplies: true,
                provider: 'device',
              },
            } },
          },
        },
      },
    });

    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    });

    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { abortLocalVoiceTurn, toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    const stopPromise = toggleLocalVoiceTurn('s1');

    await vi.waitFor(() => {
      expect(getVoiceConversationRuntimeSnapshot(), JSON.stringify({ providerId: storage.getState().settings.voice.providerId })).toMatchObject({
        controlSessionId: 's1',
        state: 'thinking',
        error: null,
      });
    });
    // This admitted turn proves that the same real outbound boundary observed
    // by the End negatives actually receives direct-session submissions.
    await vi.waitFor(() => expect(localVoicePendingEnqueue).toHaveBeenCalledOnce());

    const abortPromise = abortLocalVoiceTurn('s1');
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'ending',
      error: null,
    });

    await abortPromise;
    await stopPromise;

    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'connected',
      error: null,
    });
  });


});
