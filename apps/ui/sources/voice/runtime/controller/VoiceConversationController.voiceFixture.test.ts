import type { VoiceRealtimeConnection } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolResultV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  matchesVoiceFixtureTranscript,
  readVoiceFixturePcm16,
} from '../../../../../../packages/tests/src/testkit/voice/voiceFixture';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import { createRealtimeToolBarrier } from '@/voice/tools/realtimeToolBarrier';

import { createVoiceConversationController } from './VoiceConversationController';

function createToolConnectionFixture() {
  const events: VoiceRealtimeJsonValue[] = [];
  let finishControlEvents!: () => void;
  const controlEventsFinished = new Promise<void>((resolve) => { finishControlEvents = resolve; });
  let finishTransportEvents!: () => void;
  const transportEventsFinished = new Promise<void>((resolve) => { finishTransportEvents = resolve; });
  let remoteClosed = false;
  const connect = vi.fn(async () => {});
  const close = vi.fn(async () => {
    remoteClosed = true;
    finishControlEvents();
    finishTransportEvents();
  });
  const connection: VoiceRealtimeConnection = {
    kind: 'sdk_handle',
    connect,
    sendControl: vi.fn(async () => {}),
    controlEvents: () => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events.splice(0)) yield event;
        await controlEventsFinished;
      },
    }),
    transportEvents: () => ({
      async *[Symbol.asyncIterator]() {
        await transportEventsFinished;
      },
    }),
    close,
    state: () => remoteClosed || close.mock.calls.length > 0
      ? 'closed'
      : connect.mock.calls.length > 0
        ? 'open'
        : 'idle',
    currentProviderSessionId: () => null,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported',
    resolveOutputInterruptionCandidate: () => {},
  };
  return {
    connection,
    connect,
    events,
    finishEvents: () => {
      remoteClosed = true;
      finishControlEvents();
      finishTransportEvents();
    },
  };
}

function createToolAdapter(input: Readonly<{
  resumption: 'none' | 'resume';
  replay: 'none' | 'stable_ids';
  toolResultReplayByReason?: Readonly<Partial<Record<
    'initial' | 'reconnect' | 'auth_refresh',
    'none' | 'stable_ids'
  >>>;
  decodeControl(event: VoiceRealtimeJsonValue): ReturnType<VoiceRealtimeProtocolAdapter['decodeControl']>;
}>): VoiceRealtimeProtocolAdapter {
  return {
    id: 'tool-custody-fixture',
    turnControls: {
      cancelResponse: 'immediate',
      truncatePlayback: 'played_ms',
      clearInput: true,
      stopSession: true,
      resumption: input.resumption,
      replay: input.replay,
      exactMessage: false,
    },
    prepare: async ({ reason }) => ({
      kind: 'prepared',
      session: {
        config: {},
        safeMetadata: null,
        toolResultReplay: input.toolResultReplayByReason?.[reason] ?? 'none',
      },
    }),
    decodeControl: input.decodeControl,
    encodeTurnControl: (action) => ({ type: action }),
  };
}

describe('conversation controller canonical fixture consumer', () => {
  it('redelivers a detached result only when reconnect preparation retains its stable call identity', async () => {
    const first = createToolConnectionFixture();
    const second = createToolConnectionFixture();
    const calls = [{
      v: 1 as const,
      responseId: 'fixture-response-stable',
      callId: 'fixture-call-stable',
      toolName: 'listMachines',
      order: 0,
      arguments: { limit: 50 },
    }];
    first.events.push({ kind: 'fixture_tools' });
    const deliveryStarted = vi.fn();
    const executeCall = vi.fn(async () => ({ receipt: 'fixture-stable-receipt' }));
    const submitResults = vi.fn()
      .mockImplementationOnce(async (
        _responseId: string,
        _results: readonly VoiceRealtimeToolResultV1[],
        signal: AbortSignal,
      ) => {
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fixture_transport_detached')), { once: true });
        });
      })
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => {});
    const barrier = createRealtimeToolBarrier({
      validateCall: () => ({ status: 'allowed' as const }),
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const failed = vi.fn();
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createToolAdapter({
        resumption: 'resume',
        replay: 'stable_ids',
        toolResultReplayByReason: { initial: 'stable_ids', reconnect: 'stable_ids' },
        decodeControl: () => [{
          type: 'tool_calls',
          responseId: 'fixture-response-stable',
          calls,
        }],
      }),
      machine: {
        connecting: () => {},
        connected: () => {},
        ending: () => {},
        disconnected: () => {},
        failed,
      },
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => barrier,
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });

    await expect(controller.start({ controlSessionId: 'fixture-tool-stable' })).resolves.toEqual({ status: 'connected' });
    await vi.waitFor(() => expect(deliveryStarted).toHaveBeenCalledOnce());
    await expect(controller.requestReconnect()).resolves.toBe(true);
    await vi.waitFor(() => expect(submitResults).toHaveBeenCalledTimes(2));

    expect(executeCall).toHaveBeenCalledOnce();
    expect(continueResponse).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('fails a detached result rather than delivering it into a fresh provider session', async () => {
    const first = createToolConnectionFixture();
    const second = createToolConnectionFixture();
    const calls = [{
      v: 1 as const,
      responseId: 'fixture-response-fresh',
      callId: 'fixture-call-fresh',
      toolName: 'listMachines',
      order: 0,
      arguments: { limit: 50 },
    }];
    first.events.push({ kind: 'fixture_tools' });
    const deliveryStarted = vi.fn();
    const executeCall = vi.fn(async () => ({ receipt: 'fixture-fresh-receipt' }));
    const submitResults = vi.fn()
      .mockImplementationOnce(async (
        _responseId: string,
        _results: readonly VoiceRealtimeToolResultV1[],
        signal: AbortSignal,
      ) => {
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('fixture_transport_detached')), { once: true });
        });
      })
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => {});
    const barrier = createRealtimeToolBarrier({
      validateCall: () => ({ status: 'allowed' as const }),
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' as const }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    const failed = vi.fn();
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createToolAdapter({
        // The manifest declares resumption, but this *new* carrier did not
        // retain the response/call identity. Static declaration is insufficient.
        resumption: 'resume',
        replay: 'stable_ids',
        toolResultReplayByReason: { initial: 'stable_ids', reconnect: 'none' },
        decodeControl: () => [{
          type: 'tool_calls',
          responseId: 'fixture-response-fresh',
          calls,
        }],
      }),
      machine: {
        connecting: () => {},
        connected: () => {},
        ending: () => {},
        disconnected: () => {},
        failed,
      },
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => barrier,
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });

    await expect(controller.start({ controlSessionId: 'fixture-tool-fresh' })).resolves.toEqual({ status: 'connected' });
    await vi.waitFor(() => expect(deliveryStarted).toHaveBeenCalledOnce());
    await expect(controller.requestReconnect()).resolves.toBe(true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({
      controlSessionId: 'fixture-tool-fresh',
      attemptId: 1,
      code: 'voice_tool_result_delivery_unrecoverable',
    }));

    expect(second.connect).toHaveBeenCalledOnce();
    expect(executeCall).toHaveBeenCalledOnce();
    expect(submitResults).toHaveBeenCalledOnce();
    expect(continueResponse).not.toHaveBeenCalled();
    await controller.stop();
  });

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
