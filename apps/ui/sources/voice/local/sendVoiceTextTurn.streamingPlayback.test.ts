import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Convergence proof (RL-L4-1): the live streaming TTS path must route every
 * chunk through the canonical ordered ack'd queue (`createTtsPlaybackController`)
 * — the single ordering owner — instead of the retired ad-hoc serial promise
 * chain. We assert chunks reach `speakAssistantText` in contiguous order, and
 * that `playbackController.interrupt()` aborts the queue so no further chunk
 * plays (barge-in interrupt → queue abort preserved).
 */

const speakAssistantText = vi.fn<(params: { text: string }) => Promise<void>>();
const sendMessage = vi.fn();

vi.mock('@/voice/binding/resolveVoiceBindingBySessionId', () => ({
  resolveVoiceBindingBySessionId: () => null,
}));

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: vi.fn(),
  appendVoiceConversationAssistantText: vi.fn(),
  appendVoiceConversationNoteText: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    storage: { getState: () => ({ sessionMessages: {} }) },
  });
});

vi.mock('@/sync/sync', () => ({
  sync: { sendMessage: (...args: any[]) => sendMessage(...args) },
}));

// Streaming-enabled, device provider so `streamingSpeechEnabled` is true.
vi.mock('@/voice/local/localVoiceSettings', () => ({
  resolveLocalVoiceAdapterSettings: () => ({
    adapterId: 'local_conversation',
    config: {
      conversationMode: 'agent',
      streaming: { enabled: true, ttsEnabled: true, ttsChunkChars: 120 },
      tts: { autoSpeakReplies: true, provider: 'device' },
    },
  }),
  parseLocalVoiceTtsSettings: () => ({
    provider: 'device',
    openaiCompat: { baseUrl: null },
    autoSpeakReplies: true,
  }),
}));

vi.mock('@/voice/runtime/fetchWithTimeout', () => ({
  resolveVoiceNetworkTimeoutMs: () => 15000,
}));

vi.mock('@/voice/output/speakAssistantText', () => ({
  speakAssistantText: (params: { text: string }) => speakAssistantText(params),
}));

vi.mock('@/voice/runtime/waitForNextAssistantTextMessage', () => ({
  waitForNextAssistantTextMessage: vi.fn(),
}));

// Drive a single streaming assistant turn: push the supplied deltas then resolve
// turn 0 with the full assistant text (mirrors runVoiceAgentTurnWithTools).
const streamDeltas: { current: string[] } = { current: [] };
const onInterruptDuringStream: { current: (() => void) | null } = { current: null };

vi.mock('./runVoiceAgentTurnWithTools', () => ({
  runVoiceAgentTurnWithTools: async (params: any) => {
    for (const delta of streamDeltas.current) {
      if (params.signal?.aborted) break;
      params.onTextDelta?.(delta);
      onInterruptDuringStream.current?.();
      onInterruptDuringStream.current = null;
      await Promise.resolve();
    }
    await params.onAssistantTurn?.({
      assistantText: streamDeltas.current.join(''),
      turnIndex: 0,
    });
  },
}));

function makePlaybackController() {
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
      epoch += 1;
      const s = stopper;
      stopper = null;
      s?.();
    },
    captureEpoch: () => 1,
    isEpochCurrent: (e: number) => e === epoch,
  };
}

describe('sendVoiceTextTurn streaming playback convergence', () => {
  beforeEach(() => {
    speakAssistantText.mockReset();
    speakAssistantText.mockResolvedValue(undefined);
    sendMessage.mockReset();
    streamDeltas.current = [];
    onInterruptDuringStream.current = null;
  });

  it('routes streamed chunks through the canonical queue and speaks them in contiguous order', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    // Sentence-terminated deltas force discrete first/steady chunks.
    streamDeltas.current = ['First sentence. ', 'Second sentence. ', 'Third sentence.'];

    await sendVoiceTextTurn({
      sessionId: 's1',
      settings: {},
      userText: 'go',
      playbackController: makePlaybackController(),
      voiceAgentSessions: { sendTurn: async () => ({ assistantText: '', actions: [] }) },
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

  it('interrupt() aborts the queue: no further chunks play after a mid-stream barge-in', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
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
      sessionId: 's1',
      settings: {},
      userText: 'go',
      playbackController: controller,
      voiceAgentSessions: { sendTurn: async () => ({ assistantText: '', actions: [] }) },
    });

    const spoken = speakAssistantText.mock.calls.map((call) => call[0].text);
    // Only the first chunk should have actually been spoken; the epoch advanced
    // by interrupt() makes every later playChunk a no-op (stale epoch guard).
    expect(spoken.filter((t) => t.length > 0)).toEqual([spoken.find((t) => t.length > 0)]);
    expect(spoken.some((t) => t.includes('Gamma'))).toBe(false);
  });
});
