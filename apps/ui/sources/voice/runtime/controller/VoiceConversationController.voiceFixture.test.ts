import type { VoiceRealtimeConnection } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  matchesVoiceFixtureTranscript,
  readVoiceFixturePcm16,
} from '../../../../../../packages/tests/src/testkit/voice/voiceFixture';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';

import { createVoiceConversationController } from './VoiceConversationController';

describe('conversation controller canonical fixture consumer', () => {
  it('projects the fixture-defined two-turn sequence and settles the controller lifecycle once', async () => {
    const fixture = await readVoiceFixturePcm16('two-turns-with-pause-24k');
    const speechWindows = fixture.metadata.timelineMs.filter((entry) => entry.kind === 'speech');
    const silenceWindow = fixture.metadata.timelineMs.find((entry) => entry.kind === 'silence');
    expect(speechWindows).toHaveLength(2);
    expect(silenceWindow && silenceWindow.end - silenceWindow.start).toBeGreaterThanOrEqual(1_500);

    const rawEvents: VoiceRealtimeJsonValue[] = speechWindows.map((window, index) => {
      const startByte = Math.round(window.start / 1_000 * fixture.sampleRateHz) * 2;
      const endByte = Math.round(window.end / 1_000 * fixture.sampleRateHz) * 2;
      return {
        kind: 'fixture_transcript',
        turn: index + 1,
        pcmByteLength: fixture.pcm16Bytes.subarray(startByte, endByte).byteLength,
      };
    });
    let finishEvents!: () => void;
    const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
    let observeLateEvent!: () => void;
    const lateEventObserved = new Promise<void>((resolve) => { observeLateEvent = resolve; });
    const connection: VoiceRealtimeConnection = {
      kind: 'websocket_pcm',
      connect: vi.fn(async () => {}),
      sendControl: vi.fn(async () => {}),
      controlEvents: () => ({
        async *[Symbol.asyncIterator]() {
          for (const event of rawEvents) yield event;
          await eventsFinished;
          observeLateEvent();
          yield { kind: 'fixture_transcript', turn: 3, pcmByteLength: 2 };
        },
      }),
      transportEvents: () => ({ async *[Symbol.asyncIterator]() { await eventsFinished; } }),
      close: vi.fn(async () => { finishEvents(); }),
      state: () => 'open',
      currentProviderSessionId: () => null,
      playbackCursorMs: () => null,
      beginOutputInterruptionCandidate: () => 'unsupported',
      resolveOutputInterruptionCandidate: () => {},
    };
    const turnTexts = ['Start a new session.', 'Then open the project settings.'] as const;
    const releasePrepared = vi.fn(async () => {});
    const decodeControl = vi.fn((event: VoiceRealtimeJsonValue) => {
      const turn = Number((event as { turn?: unknown }).turn);
      const pcmByteLength = Number((event as { pcmByteLength?: unknown }).pcmByteLength);
      if (!Number.isInteger(pcmByteLength) || pcmByteLength <= 0) throw new Error('fixture_pcm_window_missing');
      const transcript: VoiceTranscriptCanonicalEventV1 = {
        v: 1,
        type: 'voice.transcript.final',
        epoch: 1,
        sequence: turn,
        revision: 1,
        eventId: `fixture-event-${turn}`,
        itemId: `fixture-turn-${turn}`,
        role: 'user',
        text: turnTexts[turn - 1] ?? '',
        provenance: 'live',
      };
      return [{ type: 'transcript' as const, event: transcript }];
    });
    const adapter: VoiceRealtimeProtocolAdapter = {
      id: 'fixture_provider',
      turnControls: {
        cancelResponse: 'immediate',
        truncatePlayback: 'played_ms',
        clearInput: true,
        stopSession: true,
        resumption: 'resume',
        replay: 'stable_ids',
        exactMessage: false,
      },
      prepare: async () => ({ kind: 'prepared', session: { config: {}, safeMetadata: null } }),
      releasePrepared,
      decodeControl,
      encodeTurnControl: (action) => ({ type: action }),
    };
    const projected: VoiceTranscriptCanonicalEventV1[] = [];
    const observations: string[] = [];
    const controller = createVoiceConversationController({
      adapter,
      machine: {
        connecting: () => observations.push('connecting'),
        connected: () => observations.push('connected'),
        ending: () => observations.push('ending'),
        disconnected: () => observations.push('disconnected'),
        failed: () => observations.push('failed'),
      },
      createConnection: async () => connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      projectTranscript: ({ event }) => {
        projected.push(event);
        observations.push(`transcript:${event.sequence}`);
      },
    });

    await expect(controller.start({ controlSessionId: 'fixture-two-turn-controller' })).resolves.toEqual({ status: 'connected' });
    await vi.waitFor(() => expect(projected).toHaveLength(2));
    expect(projected.map((event) => event.text)).toEqual(turnTexts);
    expect(matchesVoiceFixtureTranscript(fixture.metadata, projected.map((event) => event.text).join(' '))).toBe(true);
    await controller.stop();
    await lateEventObserved;
    expect(observations).toEqual([
      'connecting',
      'connected',
      'transcript:1',
      'transcript:2',
      'ending',
      'disconnected',
    ]);
    expect(decodeControl).toHaveBeenCalledTimes(2);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledWith({ code: 'user_stop' });
    expect(releasePrepared).toHaveBeenCalledOnce();
  });
});
