import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { sendVoiceTextTurn } from './sendVoiceTextTurn';

/**
 * Convergence proof (RL-L4-1): the live streaming TTS path must route every
 * chunk through the canonical ordered ack'd queue (`createTtsPlaybackController`)
 * — the single ordering owner — instead of the retired ad-hoc serial promise
 * chain. We assert chunks reach `speakAssistantText` in contiguous order, and
 * that `playbackController.interrupt()` aborts the queue so no further chunk
 * plays (barge-in interrupt → queue abort preserved).
 */

type SpeakAssistantTextParams = Readonly<{
  text: string;
  registerPlaybackStopper: (stopper: () => void) => () => void;
}>;

const speakAssistantText = vi.fn<(params: SpeakAssistantTextParams) => Promise<void>>();
const sendMessage = vi.fn();
const enqueuePendingMessage = vi.fn();
const markPendingDeliveryHandled = vi.fn();

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: vi.fn(),
  appendVoiceConversationAssistantText: vi.fn(),
  appendVoiceConversationNoteText: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    storage: {
      getState: () => ({
        settings: buildAccountSettings(),
        sessions: {
          s1: {
            id: 's1',
            active: true,
            metadata: { machineId: 'machine-1', path: '/workspace/s1' },
          },
          'carrier-s1': {
            id: 'carrier-s1',
            active: true,
            updatedAt: 1,
            metadata: {
              machineId: 'machine-1',
              path: '/workspace/s1',
              systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
              voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 's1' },
            },
          },
        },
        machines: {
          'machine-1': { id: 'machine-1', active: true, metadata: {} },
        },
        sessionMessages: {},
      }),
    },
  });
});

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: (...args: any[]) => sendMessage(...args),
    enqueuePendingMessage: (...args: any[]) => enqueuePendingMessage(...args),
    markPendingDeliveryHandled: (...args: any[]) => markPendingDeliveryHandled(...args),
    ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
    refreshSessionMessages: vi.fn(async () => {}),
    patchSessionMetadataWithRetry: vi.fn(async () => {}),
    encryption: { getSessionEncryption: vi.fn(() => ({})) },
  },
}));

vi.mock('@/voice/output/speakAssistantText', () => ({
  speakAssistantText: (params: SpeakAssistantTextParams) => speakAssistantText(params),
}));

// Drive the provider/session boundary with canonical output events; the real
// runVoiceAgentTurnWithTools owner consumes this stream.
const streamDeltas: { current: string[] } = { current: [] };
const onInterruptDuringStream: { current: (() => void) | null } = { current: null };

function makeStreamingVoiceAgentSessions() {
  return {
    sendTurn: async (_sessionId: string, _userText: string, opts?: {
      onOutputEvent?: (event: any) => void | Promise<void>;
      signal?: AbortSignal;
    }) => {
      let seq = 0;
      for (const [index, delta] of streamDeltas.current.entries()) {
        if (opts?.signal?.aborted) break;
        await opts?.onOutputEvent?.({
          v: 1,
          kind: 'speech_segment',
          turnId: 'stream-test',
          seq: seq++,
          segmentId: `stream-test:segment:${index}`,
          text: delta,
        });
        onInterruptDuringStream.current?.();
        onInterruptDuringStream.current = null;
        await Promise.resolve();
      }
      await opts?.onOutputEvent?.({
        v: 1,
        kind: 'turn_final',
        turnId: 'stream-test',
        seq,
        text: streamDeltas.current.join(''),
      });
      return { assistantText: streamDeltas.current.join(''), actions: [] };
    },
  };
}

function makeCancelledStreamingVoiceAgentSessions() {
  return {
    sendTurn: async (_sessionId: string, _userText: string, opts?: {
      onOutputEvent?: (event: any) => void | Promise<void>;
      signal?: AbortSignal;
    }) => {
      let seq = 0;
      for (const [index, delta] of streamDeltas.current.entries()) {
        await opts?.onOutputEvent?.({
          v: 1,
          kind: 'speech_segment',
          turnId: 'stream-test',
          seq: seq++,
          segmentId: `stream-test:segment:${index}`,
          text: delta,
        });
      }
      await opts?.onOutputEvent?.({
        v: 1,
        kind: 'turn_cancelled',
        turnId: 'stream-test',
        seq,
      });
      throw Object.assign(new Error('stream_cancelled'), {
        rpcErrorCode: 'cancelled',
      });
    },
  };
}

function makePlaybackController(onInterrupt?: () => void) {
  let stopper: (() => void) | null = null;
  let epoch = 1;
  return {
    registerStopper: (s: () => void) => {
      stopper = s;
      return () => {
        if (stopper === s) stopper = null;
      };
    },
    interrupt: () => {
      onInterrupt?.();
      epoch += 1;
      const s = stopper;
      stopper = null;
      s?.();
    },
    captureEpoch: () => 1,
    isEpochCurrent: (e: number) => e === epoch,
  };
}

function buildAccountSettings(ttsProvider = 'device') {
  return {
    voice: {
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: 'agent',
            agent: { backend: 'openai_compat' },
            streaming: { enabled: true, ttsEnabled: true, ttsChunkChars: 120 },
            tts: { autoSpeakReplies: true, provider: ttsProvider },
          },
        },
      },
    },
  };
}

async function establishProductionBinding() {
  resetVoiceAdapterRegistryForTests();
  registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
  for (const binding of voiceSessionBindingManager.list()) {
    voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
  }
  const binding = await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    requestedTargetSessionId: 's1',
  });
  expect(binding).toMatchObject({
    adapterId: 'local_conversation',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    conversationSessionId: 'carrier-s1',
    transcriptMode: 'synthetic',
    targetSessionId: 's1',
  });
}

describe('sendVoiceTextTurn streaming playback convergence', () => {
  beforeEach(async () => {
    voiceConversationRuntimeMachine.reset();
    speakAssistantText.mockReset();
    speakAssistantText.mockResolvedValue(undefined);
    sendMessage.mockReset();
    enqueuePendingMessage.mockReset();
    enqueuePendingMessage.mockImplementation(async (_sessionId, _text, _displayText, _meta, options) => ({
      localId: options.localId,
      accepted: true,
      externalHandoffClaimed: true,
    }));
    markPendingDeliveryHandled.mockReset();
    markPendingDeliveryHandled.mockResolvedValue(undefined);
    streamDeltas.current = [];
    onInterruptDuringStream.current = null;
  });

  it('routes streamed chunks through the canonical queue and speaks them in contiguous order', async () => {
    await establishProductionBinding();
    // Sentence-terminated deltas force discrete first/steady chunks.
    streamDeltas.current = ['First sentence. ', 'Second sentence. ', 'Third sentence.'];

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions: makeStreamingVoiceAgentSessions(),
    });

    const spoken = speakAssistantText.mock.calls.map((call) => call[0].text);
    // Every chunk reached the provider via the queue's playChunk (the empty
    // terminal sentinel is filtered out before speaking).
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.some((t) => t === '')).toBe(false);
    // Order is preserved: concatenated chunks reproduce the streamed text in
    // sequence (the queue advances only on a contiguous chunkIndex run).
    const recombined = spoken.join(' ').replace(/\s+/g, ' ').trim();
    expect(recombined).toBe('First sentence. Second sentence. Third sentence.');
  });

  it('routes registry-projected bundled TTS through the canonical streaming owner', async () => {
    await establishProductionBinding();
    streamDeltas.current = ['Bundled first. ', 'Bundled second.'];

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings('google_cloud'),
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions: makeStreamingVoiceAgentSessions(),
    });

    const spoken = speakAssistantText.mock.calls.map((call) => call[0].text);
    expect(spoken.join(' ').replace(/\s+/g, ' ').trim()).toBe('Bundled first. Bundled second.');
  });

  it('terminates streamed playback on the first provider failure without retrying later chunks', async () => {
    await establishProductionBinding();
    streamDeltas.current = ['Unavailable first. ', 'Must not retry.'];
    const providerError = Object.assign(new Error('voice_tts_provider_unavailable'), {
      code: 'provider_unavailable',
    });
    speakAssistantText.mockRejectedValue(providerError);

    const outcome = await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings('google_cloud'),
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions: makeStreamingVoiceAgentSessions(),
      durableDispatch: {
        localId: 'tts-failure-turn',
        deliveryCommand: 'interrupt_and_send',
      },
    }).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'provider_unavailable' },
    });
    expect(speakAssistantText).toHaveBeenCalledTimes(1);
    expect(voiceConversationRuntimeMachine.getSnapshot().error).toMatchObject({
      kind: 'tts_failed',
      reason: 'voice_tts_provider_unavailable',
    });
  });

  it('aborts queued and active playback exactly once when the canonical turn is cancelled', async () => {
    await establishProductionBinding();
    streamDeltas.current = ['Active first. ', 'Queued second.'];
    const releaseFirst = { current: null as (() => void) | null };
    const events: string[] = [];
    const stopActivePlayback = vi.fn(() => {
      events.push('stop');
      releaseFirst.current?.();
    });
    speakAssistantText.mockImplementation(async (params) => {
      events.push(`speak:${params.text}`);
      if (speakAssistantText.mock.calls.length !== 1) return;
      const clearStopper = params.registerPlaybackStopper(stopActivePlayback);
      await new Promise<void>((resolve) => {
        releaseFirst.current = resolve;
      });
      clearStopper();
    });
    const onInterrupt = vi.fn(() => {
      events.push('interrupt');
    });

    let turnSettled = false;
    const turn = sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings('google_cloud'),
      userText: 'go',
      playbackController: makePlaybackController(onInterrupt),
      voiceAgentSessions: makeCancelledStreamingVoiceAgentSessions(),
    }).catch(() => {}).finally(() => {
      turnSettled = true;
      events.push('turn:settled');
    });

    try {
      await vi.waitFor(() => expect(turnSettled).toBe(true));
    } finally {
      // Always release a defective implementation's orphaned first playback so
      // the test itself cannot leave queue work behind after recording the result.
      releaseFirst.current?.();
      await turn;
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(stopActivePlayback).toHaveBeenCalledTimes(1);
    expect(speakAssistantText).toHaveBeenCalledTimes(1);
    expect(events.indexOf('stop')).toBeLessThan(events.indexOf('turn:settled'));
    expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
      state: 'connected',
      error: null,
    });
  });

  it('interrupt() aborts the queue: no further chunks play after a mid-stream barge-in', async () => {
    await establishProductionBinding();
    const controller = makePlaybackController();
    streamDeltas.current = ['Alpha sentence. ', 'Beta sentence. ', 'Gamma sentence.'];

    // Block the first chunk's playback, then interrupt while it is in flight.
    let releaseFirst: (() => void) | null = null;
    speakAssistantText.mockImplementation(async () => {
      if (speakAssistantText.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    // After the first delta is pushed, fire the interrupt (barge-in).
    onInterruptDuringStream.current = () => {
      // Wait for the first chunk to begin, then interrupt and release it.
      void vi.waitFor(() => expect(speakAssistantText).toHaveBeenCalled()).then(() => {
        controller.interrupt();
        releaseFirst?.();
      });
    };

    await sendVoiceTextTurn({
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      settings: buildAccountSettings(),
      userText: 'go',
      playbackController: controller,
      voiceAgentSessions: makeStreamingVoiceAgentSessions(),
    });

    const spoken = speakAssistantText.mock.calls.map((call) => call[0].text);
    // Only the first chunk should have actually been spoken; the epoch advanced
    // by interrupt() makes every later playChunk a no-op (stale epoch guard).
    expect(spoken.filter((t) => t.length > 0)).toEqual([spoken.find((t) => t.length > 0)]);
    expect(spoken.some((t) => t.includes('Gamma'))).toBe(false);
  });
});
