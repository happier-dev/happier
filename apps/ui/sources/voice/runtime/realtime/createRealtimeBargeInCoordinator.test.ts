import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { createXaiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/xaiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPublicPcmVoiceConversationForTest } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';

vi.mock('react-native', async () => (
  await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock());

vi.mock('socket.io-client', async importOriginal => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

vi.mock('expo-audio', async () => (
  await import('@/dev/testkit/mocks/expoAudio')
).expoAudioModuleMock());

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => createVoiceConversationRuntimeMachine().reset());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  createVoiceConversationRuntimeMachine().reset();
});

const startPublicPcmConversation = () => createPublicPcmVoiceConversationForTest(cleanup => cleanups.push(cleanup));

async function waitForInterrupted(conversation: Awaited<ReturnType<typeof startPublicPcmConversation>>, entryId: string) {
  const { storage } = await import('@/sync/domains/state/storage');
  await waitForTestEvent(storage.subscribe, () => conversation.isVoiceTurnInterrupted(entryId), Boolean);
}

describe('public SDK PCM interruption conformance', () => {
  it('marks only the actual persisted assistant final after real PCM retention and confirmation', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    expect(conversation.playbackCursorMs()).toBe(0);
    const entryId = await conversation.finalizeAssistant();
    conversation.advanceClock(1_500);
    conversation.context.currentTime = 0.45;
    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[0]!.stopped;
    expect(conversation.context.sources[0]!.stop).toHaveBeenCalled();
    expect(conversation.playbackCursorMs()).toBe(450);
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(false);
    conversation.emit({ kind: 'speech.started' });
    expect(conversation.context.sources[0]!.stop).toHaveBeenCalledTimes(1);
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please stop and answer this question' });
    await waitForInterrupted(conversation, entryId);
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(true);
    expect(conversation.sent).toContainEqual({ kind: 'cancel' });
    expect(conversation.readMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'agent-text', text: 'current response' }),
    ]));
  });

  it('upgrades anonymous output to its persisted exact final without borrowing another turn', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput(null);
    conversation.emit({ kind: 'audio.started', item: 'turn-n' });
    const entryId = await conversation.finalizeAssistant();
    conversation.advanceClock(1_500);
    conversation.emit({ kind: 'speech.started' });
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please stop and answer this question' });
    await waitForInterrupted(conversation, entryId);
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(true);
    expect(conversation.sent).toContainEqual({ kind: 'cancel' });
  });

  it.each([false, true])('never marks N-1 when current output lacks a final (ambiguous: %s)', async ambiguous => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    const previousEntryId = await conversation.finalizeAssistant('turn-n-minus-one', 'previous response');
    if (ambiguous) conversation.emit({ kind: 'audio.started' });
    conversation.advanceClock(1_500);
    conversation.emit({ kind: 'speech.started' });
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please stop and answer this question' });
    await conversation.sdk.controlSent('cancel');
    expect(conversation.sent).toContainEqual({ kind: 'cancel' });
    expect(conversation.isVoiceTurnInterrupted(previousEntryId)).toBe(false);
  });

  it('marks the exact persisted final arriving after speech onset but before confirmation', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[0]!.stopped;
    expect(conversation.context.sources[0]!.stop).toHaveBeenCalled();
    const entryId = await conversation.finalizeAssistant();
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(false);
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please stop and answer this question' });
    await waitForInterrupted(conversation, entryId);
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(true);
  });

  it('marks the exact persisted final arriving after interruption confirmation', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.emit({ kind: 'speech.started' });
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please stop and answer this question' });
    await conversation.sdk.controlSent('cancel');
    expect(conversation.sent).toContainEqual({ kind: 'cancel' });
    const entryId = await conversation.finalizeAssistant();
    await waitForInterrupted(conversation, entryId);
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(true);
  });

  it('does not mark either persisted final when overlapping output invalidates the candidate identity', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    const entryId = await conversation.finalizeAssistant();
    conversation.advanceClock(1_500);
    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[0]!.stopped;
    expect(conversation.context.sources[0]!.stop).toHaveBeenCalled();
    await conversation.startOutput('turn-overlap');
    const overlapEntryId = await conversation.finalizeAssistant('turn-overlap', 'overlapping response');
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please stop and answer this question' });
    await conversation.sdk.controlSent('cancel');
    expect(conversation.sent).toContainEqual({ kind: 'cancel' });
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(false);
    expect(conversation.isVoiceTurnInterrupted(overlapEntryId)).toBe(false);
  });

  it('does not mark a naturally completed persisted output when the user final arrives later', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    const entryId = await conversation.finalizeAssistant();
    conversation.advanceClock(1_500);
    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[0]!.stopped;
    expect(conversation.context.sources[0]!.stop).toHaveBeenCalled();
    conversation.emit({ kind: 'audio.stopped' });
    conversation.emit({ kind: 'final', role: 'user', item: 'user-n', text: 'please answer my next question' });
    await conversation.waitForUser('please answer my next question');
    await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => createVoiceConversationRuntimeMachine().getSnapshot(), snapshot => snapshot.state === 'connected');
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'connected' });
    expect(conversation.sent).not.toContainEqual({ kind: 'cancel' });
    expect(conversation.isVoiceTurnInterrupted(entryId)).toBe(false);
  });

  it('restores the actual retained PCM tail for backchannels, output completion, timeout and reconnect', async () => {
    const conversation = await startPublicPcmConversation();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.context.currentTime = 0.45;
    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[0]!.stopped;
    expect(conversation.context.sources[0]!.stop).toHaveBeenCalled();
    conversation.emit({ kind: 'final', role: 'user', item: 'backchannel', text: 'okay' });
    await conversation.context.sourceCreated(1);
    expect(conversation.context.sources).toHaveLength(2);
    expect(conversation.context.sources[1]!.buffer!.samples).toHaveLength(13_200);
    expect(conversation.context.sources[1]!.start).toHaveBeenCalledWith(0.45);

    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[1]!.stopped;
    expect(conversation.context.sources[1]!.stop).toHaveBeenCalled();
    conversation.emit({ kind: 'audio.stopped' });
    await conversation.context.sourceCreated(2);
    expect(conversation.context.sources).toHaveLength(3);

    // The browser finishes the resumed tail before the next vendor output.
    // Otherwise both tails legitimately exceed the owner's retention budget.
    conversation.context.currentTime = 1;
    conversation.context.sources[2]!.onended?.();

    await conversation.startOutput('next-output');
    conversation.advanceClock(1_500);
    vi.useFakeTimers();
    conversation.emit({ kind: 'speech.started' });
    await conversation.context.sources[3]!.stopped;
    expect(conversation.context.sources[3]!.stop).toHaveBeenCalled();
    const sourcesBeforeTimeout = conversation.context.sources.length;
    conversation.emit({ kind: 'speech.stopped' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(conversation.context.sources.length).toBeGreaterThan(sourcesBeforeTimeout);
    vi.useRealTimers();

    conversation.emit({ kind: 'speech.started' });
    const oldContext = conversation.context;
    await oldContext.sources.at(-1)!.stopped;
    expect(oldContext.sources.at(-1)!.stop).toHaveBeenCalled();
    const oldConnection = conversation.getConnection()!;
    const oldTrack = conversation.browser.micTrack;
    const sourcesBeforeReconnect = oldContext.sources.length;
    const attemptId = conversation.getController().getOwnedAttemptId();
    expect(await conversation.requestReconnect()).toBe(true);
    expect(oldConnection.state()).toBe('closed');
    expect(conversation.getConnection()).not.toBe(oldConnection);
    expect(conversation.getConnection()!.state()).toBe('open');
    expect(conversation.getController().getOwnedAttemptId()).toBe(attemptId);
    // Reconnect replaces the carrier/scheduler, not this attempt's shared mic.
    expect(conversation.context).toBe(oldContext);
    expect(oldContext.close).not.toHaveBeenCalled();
    expect(conversation.browser.micTrack).toBe(oldTrack);
    expect(oldTrack.readyState).toBe('live');
    // Coordinator reset restores the retained tail before carrier retirement;
    // retirement then stops it, and the replacement scheduler starts empty.
    const restoredAtReconnect = oldContext.sources[sourcesBeforeReconnect]!;
    expect(restoredAtReconnect.buffer!.samples).toHaveLength(24_000);
    expect(restoredAtReconnect.start).toHaveBeenCalledWith(1);
    expect(restoredAtReconnect.stop).toHaveBeenCalled();
    expect(conversation.playbackCursorMs()).toBe(0);
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'connected' });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(conversation.sent).not.toContainEqual({ kind: 'cancel' });
  });
});


async function startActualOpenAiConversation() {
  const environment = await createOpenAiVoiceRuntimeEnvironment();
  const browser = installVoiceWebRtcBrowserBoundary();
  // The physical browser realm selects the host's existing web audio path;
  // no native audio-mode owner or lease is substituted.
  vi.stubGlobal('window', Object.assign(new EventTarget(), {}));
  const playbackEntered = createDeferred<void>();
  const audioListeners = new Set<() => void>();
  let volume = 1;
  const remoteAudio = { autoplay: false, srcObject: null as MediaStream | null,
    get volume() { return volume; },
    set volume(value: number) { volume = value; for (const listener of audioListeners) listener(); },
    play: vi.fn(async () => { playbackEntered.resolve(); }), pause: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible',
    createElement: (tag: string) => {
      if (tag !== 'audio') throw new Error(`Unexpected browser element: ${tag}`);
      return remoteAudio;
    },
  }));
  const locks = installWebLockManagerMock();
  // The coordinator captures Date.now when constructed, so install the clock
  // boundary before actual provider activation constructs it.
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const composed = await environment.createRuntime(browser);
  cleanups.push(async () => {
    await composed.runtime.dispose();
    composed.hostLease.revoke();
    await environment.dispose();
    locks.restore();
    browser.restore();
    vi.useRealTimers();
  });
  const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
  void starting.catch(() => {});
  const peer = await browser.peerCreated();
  await peer.dataChannelCreated;
  expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
  browser.peer.channel.open();
  await starting;
  const controller = composed.controller;
  if (!controller) throw new Error('The actual OpenAI controller was not constructed');
  const { readCanonicalVoiceTranscriptSnapshot } = await import('@/voice/transcript/voiceConversationTranscript');
  const { storage } = await import('@/sync/domains/state/storage');
  let sequence = 0;
  const emit = (event: Readonly<Record<string, unknown>>) => browser.peer.channel.message(JSON.stringify({
    event_id: `coordinator-provider-${++sequence}`, ...event,
  }));
  const controls = () => browser.peer.channel.sent.flatMap(serialized => {
    const event: unknown = JSON.parse(serialized);
    return event && typeof event === 'object' && 'type' in event && typeof event.type === 'string'
      ? [event.type] : [];
  }).filter(type => type === 'response.cancel' || type === 'response.create' || type === 'output_audio_buffer.clear');
  const startOutput = async () => {
    emit({ type: 'output_audio_buffer.started', response_id: 'coordinator-response' });
    const machine = createVoiceConversationRuntimeMachine();
    await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, machine.getSnapshot, snapshot => snapshot.state === 'speaking');
    expect(machine.getSnapshot()).toMatchObject({
      state: 'speaking', controlSessionId: composed.controlSessionId,
    });
  };
  const startSpeech = () => emit({ type: 'input_audio_buffer.speech_started', item_id: 'coordinator-user', audio_start_ms: 0 });
  const stopSpeech = () => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'coordinator-user', audio_end_ms: 1_500 });
  const stopOutput = () => emit({ type: 'output_audio_buffer.stopped', response_id: 'coordinator-response' });
  const finalizeUser = (text: string) => emit({
    type: 'conversation.item.input_audio_transcription.completed', item_id: 'coordinator-user', content_index: 0,
    transcript: text, usage: { type: 'duration', seconds: 1 },
  });
  const waitForUser = async (text: string) => {
    await waitForTestEvent(storage.subscribe, () => readCanonicalVoiceTranscriptSnapshot(environment.historySessionId),
      entries => entries.some(entry => entry.role === 'user' && entry.text === text));
    expect(readCanonicalVoiceTranscriptSnapshot(environment.historySessionId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', text })]));
  };
  const waitForControl = (type: string) => peer.channel.controlSent(serialized => {
    const event: unknown = JSON.parse(serialized);
    return event !== null && typeof event === 'object' && 'type' in event && event.type === type;
  });
  const waitForVolume = (predicate: (value: number) => boolean) => waitForTestEvent(
    notify => { audioListeners.add(notify); return () => { audioListeners.delete(notify); }; },
    () => remoteAudio.volume, predicate,
  );
  return { composed, controller, browser, remoteAudio, emit, controls, startOutput, stopOutput, startSpeech, stopSpeech, finalizeUser, waitForUser,
    waitForControl, waitForVolume, playbackEntered: playbackEntered.promise,
    advanceClock: (milliseconds: number) => { now += milliseconds; } };
}

describe('realtime barge-in through the actual OpenAI producer', () => {
  it('ducks actual attached RTC audio for speech and restores it for a finalized backchannel', async () => {
    const conversation = await startActualOpenAiConversation();
    conversation.browser.peer.remoteTrack(conversation.browser.micTrack, [conversation.browser.micStream]);
    await conversation.playbackEntered;
    expect(conversation.remoteAudio.play).toHaveBeenCalled();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.startSpeech();
    await conversation.waitForVolume(volume => volume < 1);
    expect(conversation.remoteAudio.volume).toBeLessThan(1);
    expect(conversation.remoteAudio.volume).toBeGreaterThan(0);
    expect(conversation.controller.playbackCursorMs()).toBeNull();
    conversation.finalizeUser('okay');
    await conversation.waitForUser('okay');
    await conversation.waitForVolume(volume => volume === 1);
    expect(conversation.remoteAudio.volume).toBe(1);
    expect(conversation.controls()).toEqual([]);
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'speaking' });
  });

  it.each(['Привет, как дела', 'こんにちは', 'مرحبا بالعالم'])('confirms a meaningful Unicode interruption: %s', async text => {
    const conversation = await startActualOpenAiConversation();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.startSpeech();
    conversation.finalizeUser(text);
    await conversation.waitForUser(text);
    await conversation.waitForControl('output_audio_buffer.clear');
    expect(conversation.controls()).toEqual(['response.cancel', 'output_audio_buffer.clear']);
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({
      state: 'speaking', controlSessionId: conversation.composed.controlSessionId,
    });
    expect(conversation.controller.playbackCursorMs()).toBeNull();
  });

  it('does not cancel naturally completed output when the user final arrives later', async () => {
    const conversation = await startActualOpenAiConversation();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.startSpeech();
    conversation.stopOutput();
    const text = 'please answer my next question';
    conversation.finalizeUser(text);
    await conversation.waitForUser(text);
    expect(conversation.controls()).toEqual([]);
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'connected' });
  });

  it('confirms sustained VAD before any provider transcript arrives and continues only after both speech and output stop', async () => {
    const conversation = await startActualOpenAiConversation();
    await conversation.startOutput();
    vi.useFakeTimers();
    conversation.startSpeech();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(800);
    expect(conversation.controls()).toEqual(['response.cancel', 'output_audio_buffer.clear']);
    conversation.stopOutput();
    await vi.advanceTimersByTimeAsync(0);
    expect(conversation.controls()).not.toContain('response.create');
    conversation.stopSpeech();
    await vi.advanceTimersByTimeAsync(0);
    await conversation.waitForControl('response.create');
    expect(conversation.controls()).toEqual([
      'response.cancel', 'output_audio_buffer.clear', 'response.create',
    ]);
    expect(conversation.controls().filter(type => type === 'response.create')).toHaveLength(1);
  });

  it('cancels sustained-speech confirmation when a short VAD transient stops first', async () => {
    const conversation = await startActualOpenAiConversation();
    await conversation.startOutput();
    vi.useFakeTimers();
    conversation.startSpeech();
    await vi.advanceTimersByTimeAsync(300);
    conversation.stopSpeech();
    await vi.advanceTimersByTimeAsync(600);
    expect(conversation.controls()).toEqual([]);
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'speaking' });
  });

  it('continues exactly once after stopped substantive speech and contains a physical continuation-send failure', async () => {
    const conversation = await startActualOpenAiConversation();
    const send = conversation.browser.peer.channel.send.bind(conversation.browser.peer.channel);
    const rejected: string[] = [];
    vi.spyOn(conversation.browser.peer.channel, 'send').mockImplementation(serialized => {
      const event: unknown = JSON.parse(serialized);
      if (event && typeof event === 'object' && 'type' in event && event.type === 'response.create') {
        rejected.push(serialized);
        throw new Error('continue_failed');
      }
      send(serialized);
    });
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.startSpeech();
    conversation.stopSpeech();
    conversation.finalizeUser('please answer my new question now');
    await conversation.waitForControl('response.cancel');
    expect(conversation.controls()).toContain('response.cancel');
    conversation.stopOutput();
    conversation.stopSpeech();
    await waitForTestEvent(conversation.composed.runtime.adapter.subscribe!, conversation.composed.runtime.adapter.getSnapshot, snapshot => snapshot.status === 'error');
    expect(conversation.composed.runtime.adapter.getSnapshot()).toMatchObject({
      status: 'error', errorCode: 'voice_webrtc_data_channel_send_failed',
    });
    expect(rejected).toHaveLength(1);
    expect(conversation.controller.getOwnedAttemptId()).toBeNull();
    expect(conversation.browser.micTrack.stop).toHaveBeenCalled();
  });

  it('does not create the replacement response until cancelled output actually stops', async () => {
    const conversation = await startActualOpenAiConversation();
    await conversation.startOutput();
    conversation.advanceClock(1_500);
    conversation.startSpeech();
    conversation.stopSpeech();
    conversation.finalizeUser('please answer this new question');
    await conversation.waitForControl('output_audio_buffer.clear');
    expect(conversation.controls()).toEqual(['response.cancel', 'output_audio_buffer.clear']);
    conversation.stopOutput();
    await conversation.waitForControl('response.create');
    expect(conversation.controls()).toEqual([
      'response.cancel', 'output_audio_buffer.clear', 'response.create',
    ]);
  });

});

describe('realtime speech through the actual xAI producer', () => {
  it('stops provider-immediate output on speech without creating a competing client response', async () => {
    const environment = await createXaiVoiceRuntimeEnvironment();
    await environment.installSettings(false);
    const composed = await environment.createRuntime();
    cleanups.push(async () => {
      await composed.dispose();
      await environment.dispose();
      vi.useRealTimers();
    });
    await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
    const socket = environment.physicalSockets[0]!;
    let sequence = 0;
    const emit = (event: Readonly<Record<string, unknown>>) => socket.emit('message', {
      data: JSON.stringify({ event_id: `disabled-client-${++sequence}`, ...event }),
    });
    vi.useFakeTimers();
    emit({ type: 'input_audio_buffer.speech_started' });
    emit({ type: 'input_audio_buffer.speech_stopped' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(environment.audioContexts.at(-1)!.sources).toHaveLength(0);
    const samples = new Int16Array(24_000).fill(2_000);
    emit({ type: 'response.output_audio.delta', item_id: 'xai-output', response_id: 'xai-response',
      delta: Buffer.from(samples.buffer).toString('base64') });
    await vi.advanceTimersByTimeAsync(0);
    const context = environment.audioContexts.at(-1)!;
    expect(context.sources).toHaveLength(1);
    emit({ type: 'input_audio_buffer.speech_started' });
    emit({ type: 'input_audio_buffer.speech_stopped' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(socket.sent.map(serialized => JSON.parse(serialized))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response.cancel' }),
    ]));
    expect(socket.sent.map(serialized => JSON.parse(serialized))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'response.create' }),
    ]));
    expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'connected' });
  });
});
