import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceAgentOutputTurnV1,
  ingestVoiceAgentOutputEventV1,
  VoiceAgentOutputEventV1Schema,
  type VoiceAgentOutputEventV1,
} from '@happier-dev/protocol';
import {
  finalizeVoiceAgentStreamingSpeech,
  ingestVoiceAgentStreamingDelta,
} from '../../../../cli/src/agent/voice/agent/voiceAgentStreamingDeltas';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import type { VoiceAgentSendTurnOptions } from '@/voice/agent/types';
import { sendVoiceTextTurn } from './sendVoiceTextTurn';

const speech = vi.hoisted(() => ({
  speak: vi.fn<(text: string, options: { onStart?: () => void; onDone?: () => void }) => void>(),
  stop: vi.fn(),
}));

// The OS speech engine is the only replaced part of the real TTS/playback path.
vi.mock('expo-speech', () => speech);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

function settings() {
  return {
    voice: {
      providerId: 'local_conversation',
      providers: {
        local_conversation: {
          schemaVersion: 1,
          config: {
            conversationMode: 'agent',
            streaming: { enabled: true, ttsEnabled: true, ttsChunkChars: 120 },
            tts: { autoSpeakReplies: true, provider: 'device' },
          },
        },
      },
    },
  };
}

describe('accepted semantic speech playback', () => {
  beforeEach(() => {
    voiceConversationRuntimeMachine.reset();
    speech.speak.mockReset();
    speech.stop.mockReset();
  });

  it.each(['final', 'cancelled'] as const)(
    'starts the real producer first sentence before %s and preserves playback backpressure',
    async (terminal) => {
      const audio: string[] = [];
      let finishFirst: (() => void) | undefined;
      let terminalPublished = false;
      speech.speak.mockImplementation((text, options) => {
        audio.push(text);
        options.onStart?.();
        if (audio.length === 1) finishFirst = options.onDone;
        else options.onDone?.();
      });
      const playbackController = createVoicePlaybackController();
      const stream = {
        done: false,
        suppressActionDeltas: false,
        deltaHold: '',
        outputSpeechBuffer: '',
        outputSpeechText: '',
        outputBudget: createVoiceAgentOutputTurnV1('semantic-turn'),
        outputIncomplete: false,
        events: [] as unknown[],
        id: 'semantic-turn',
        outputSeq: 0,
        outputSegmentIndex: 0,
      };
      const patch = (next: Partial<typeof stream>) => Object.assign(stream, next);
      let accepted = createVoiceAgentOutputTurnV1(stream.id);
      let cursor = 0;
      const sessions = {
        sendTurn: async (_sessionId: string, _text: string, options?: VoiceAgentSendTurnOptions) => {
          const consume = async (event: VoiceAgentOutputEventV1) => {
            const result = ingestVoiceAgentOutputEventV1(accepted, event);
            accepted = result.state;
            await options?.onOutputEvent?.({ event, effects: result.effects });
          };
          const drain = async () => {
            while (cursor < stream.events.length) {
              const envelope = stream.events[cursor++] as { output: unknown };
              await consume(VoiceAgentOutputEventV1Schema.parse(envelope.output));
            }
          };
          const remainder = 'unfinished '.repeat(14);
          ingestVoiceAgentStreamingDelta(stream, patch, `Sure. ${remainder}`);
          await drain();
          expect(accepted.spokeAnySegment).toBe(true);
          expect(stream.outputSegmentIndex).toBe(1);
          try {
            await vi.waitFor(() => expect(audio).toEqual(['Sure.']));
            expect(terminalPublished).toBe(false);
            finalizeVoiceAgentStreamingSpeech(stream, patch);
            await drain();
            // The admitted remainder is queued, but the held first playback
            // still owns the physical output until it completes or is stopped.
            expect(audio).toEqual(['Sure.']);
            terminalPublished = true;
            if (terminal === 'cancelled') {
              await consume({ v: 1, kind: 'turn_cancelled', turnId: stream.id, seq: stream.outputSeq });
              return { assistantText: '', actions: [] };
            }
            finishFirst?.();
            await consume({
              v: 1, kind: 'turn_final', turnId: stream.id,
              seq: stream.outputSeq, text: `Sure. ${remainder}`,
            });
            return { assistantText: `Sure. ${remainder}`, actions: [] };
          } finally {
            // A failed RED assertion must not leave a held native playback.
            finishFirst?.();
          }
        },
      };

      await sendVoiceTextTurn({
        sessionId: 'semantic-session',
        settings: settings(),
        userText: 'go',
        playbackController,
        voiceAgentSessions: sessions,
        durableDispatch: { localId: 'semantic-local', deliveryCommand: 'interrupt_and_send' },
      });

      expect(audio).toEqual(terminal === 'cancelled'
        ? ['Sure.']
        : ['Sure.', 'unfinished '.repeat(14).trim()]);
      expect(speech.stop).toHaveBeenCalledTimes(terminal === 'cancelled' ? 1 : 0);
    },
  );
});
