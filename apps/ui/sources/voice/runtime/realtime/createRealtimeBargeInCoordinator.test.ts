import { describe, expect, it, vi } from 'vitest';

import { createRealtimeBargeInCoordinator } from './createRealtimeBargeInCoordinator';

describe('createRealtimeBargeInCoordinator', () => {
  it('retains output on speech onset and only interrupts for a substantive finalized turn', async () => {
    let now = 1_000;
    const begin = vi.fn(() => 'retained' as const);
    const resolve = vi.fn();
    const interrupt = vi.fn(async () => undefined);
    const transitionToSpeaking = vi.fn();
    const transitionToConnected = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: begin,
      resolveOutputInterruptionCandidate: resolve,
      interrupt,
      transitionToSpeaking,
      transitionToConnected,
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted();
    now += 1_500;
    coordinator.onInputSpeechStarted();
    expect(begin).toHaveBeenCalledTimes(1);
    coordinator.onInputSpeechStarted();
    expect(begin).toHaveBeenCalledTimes(1);
    await coordinator.onTranscript({ role: 'user', type: 'voice.transcript.final', text: 'please stop and answer this question' });

    expect(resolve).toHaveBeenCalledWith('confirmed');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(transitionToSpeaking).toHaveBeenCalledWith('voice-global');
  });

  it('reports the confirmed heard prefix from the playback cursor captured at speech onset', async () => {
    let playbackCursorMs = 1_000;
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => playbackCursorMs,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted();
    playbackCursorMs = 1_450;
    now += 1_000;
    coordinator.onInputSpeechStarted();
    playbackCursorMs = 2_000;
    await coordinator.onTranscript({
      role: 'user', type: 'voice.transcript.final', text: 'please stop and answer this question',
    });

    expect(onConfirmedInterruption).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      playedMs: 450,
      assistantEntryId: null,
    });
  });

  it('carries only the exact active output final identity into confirmed interruption', async () => {
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'current response',
      itemId: 'turn-n',
      assistantEntryId: 'persisted-turn-n',
    });
    now += 1_500;
    coordinator.onInputSpeechStarted();
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please stop and answer this question',
    });

    expect(onConfirmedInterruption).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: 'persisted-turn-n',
    });
  });

  it('upgrades an anonymous active output to its exact transcript item before interruption persistence', async () => {
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted();
    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'current response',
      itemId: 'turn-n',
      assistantEntryId: 'persisted-turn-n',
    });
    now += 1_500;
    coordinator.onInputSpeechStarted();
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please stop and answer this question',
    });

    expect(onConfirmedInterruption).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: 'persisted-turn-n',
    });
  });

  it('does not reuse N-1 when active output N has no final or an ambiguous output identity', async () => {
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'previous response',
      itemId: 'turn-n-minus-one',
      assistantEntryId: 'persisted-turn-n-minus-one',
    });
    coordinator.onAssistantOutputStarted();
    now += 1_500;
    coordinator.onInputSpeechStarted();
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please stop and answer this question',
    });

    expect(onConfirmedInterruption).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: null,
    });
  });

  it('binds an exact assistant final that arrives after speech onset but before confirmation', async () => {
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    now += 1_500;
    coordinator.onInputSpeechStarted();
    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'current response',
      itemId: 'turn-n',
      assistantEntryId: 'persisted-turn-n',
    });
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please stop and answer this question',
    });

    expect(onConfirmedInterruption).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: 'persisted-turn-n',
    });
  });

  it('reports the exact assistant identity when its final arrives after interruption confirmation', async () => {
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    now += 1_500;
    coordinator.onInputSpeechStarted();
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please stop and answer this question',
    });
    expect(onConfirmedInterruption).toHaveBeenCalledExactlyOnceWith({
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: null,
    });

    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'current response',
      itemId: 'turn-n',
      assistantEntryId: 'persisted-turn-n',
    });

    expect(onConfirmedInterruption).toHaveBeenNthCalledWith(2, {
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: 'persisted-turn-n',
    });
  });

  it('clears a candidate final identity when output becomes overlapping before confirmation', async () => {
    let now = 1_000;
    const onConfirmedInterruption = vi.fn();
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: vi.fn(),
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'current response',
      itemId: 'turn-n',
      assistantEntryId: 'persisted-turn-n',
    });
    now += 1_500;
    coordinator.onInputSpeechStarted();
    coordinator.onAssistantOutputStarted({ itemId: 'turn-overlap' });
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please stop and answer this question',
    });

    expect(onConfirmedInterruption).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      playedMs: 0,
      assistantEntryId: null,
    });
  });

  it('does not mark a naturally completed output interrupted when the user final arrives later', async () => {
    let now = 1_000;
    const resolve = vi.fn();
    const onConfirmedInterruption = vi.fn();
    const interrupt = vi.fn(async () => undefined);
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'retained',
      resolveOutputInterruptionCandidate: resolve,
      readPlaybackCursorMs: () => 0,
      onConfirmedInterruption,
      interrupt,
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => true,
      now: () => now,
    });

    coordinator.onAssistantOutputStarted({ itemId: 'turn-n' });
    await coordinator.onTranscript({
      role: 'assistant',
      type: 'voice.transcript.final',
      text: 'completed response',
      itemId: 'turn-n',
      assistantEntryId: 'persisted-turn-n',
    });
    now += 1_500;
    coordinator.onInputSpeechStarted();
    coordinator.onAssistantOutputStopped();
    await coordinator.onTranscript({
      role: 'user',
      type: 'voice.transcript.final',
      text: 'please answer my next question',
    });

    expect(resolve).toHaveBeenLastCalledWith('false_alarm');
    expect(onConfirmedInterruption).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('resumes retained output for backchannels, empty turns, output completion, timeout, and reconnect cleanup', async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn();
      const interrupt = vi.fn(async () => undefined);
      const coordinator = createRealtimeBargeInCoordinator({
        beginOutputInterruptionCandidate: () => 'retained',
        resolveOutputInterruptionCandidate: resolve,
        interrupt,
        transitionToSpeaking: vi.fn(),
        transitionToConnected: vi.fn(),
        getControlSessionId: () => 'voice-global',
        isBargeInEnabled: () => true,
        candidateMaxMs: 100,
      });

      coordinator.onAssistantOutputStarted();
      coordinator.onInputSpeechStarted();
      await coordinator.onTranscript({ role: 'user', type: 'voice.transcript.final', text: 'okay' });
      expect(resolve).toHaveBeenLastCalledWith('false_alarm');
      expect(interrupt).not.toHaveBeenCalled();

      coordinator.onInputSpeechStarted();
      coordinator.onAssistantOutputStopped();
      expect(resolve).toHaveBeenLastCalledWith('false_alarm');

      coordinator.onAssistantOutputStarted();
      coordinator.onInputSpeechStarted();
      await vi.advanceTimersByTimeAsync(100);
      expect(resolve).toHaveBeenLastCalledWith('false_alarm');

      coordinator.onInputSpeechStarted();
      coordinator.reset();
      expect(resolve).toHaveBeenLastCalledWith('false_alarm');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores speech edges when output is not active or barge-in is disabled', () => {
    const begin = vi.fn(() => 'retained' as const);
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: begin,
      resolveOutputInterruptionCandidate: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      transitionToSpeaking: vi.fn(),
      transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global',
      isBargeInEnabled: () => false,
    });
    coordinator.onInputSpeechStarted();
    coordinator.onAssistantOutputStarted();
    coordinator.onInputSpeechStarted();
    expect(begin).not.toHaveBeenCalled();
  });

  it('confirms sustained VAD speech when provider transcription is disabled', async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn();
      const interrupt = vi.fn(async () => undefined);
      const continueAfterConfirmedSpeech = vi.fn(async () => undefined);
      const coordinator = createRealtimeBargeInCoordinator({
        beginOutputInterruptionCandidate: () => 'ducked',
        resolveOutputInterruptionCandidate: resolve,
        interrupt,
        transitionToSpeaking: vi.fn(), transitionToConnected: vi.fn(),
        getControlSessionId: () => 'voice-global', isBargeInEnabled: () => true,
        speechConfirmMs: 800,
        continueAfterConfirmedSpeech,
      });
      coordinator.onAssistantOutputStarted();
      coordinator.onInputSpeechStarted();

      await vi.advanceTimersByTimeAsync(800);

      expect(resolve).toHaveBeenCalledWith('confirmed');
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(continueAfterConfirmedSpeech).not.toHaveBeenCalled();

      // Provider cancellation commonly emits output-stopped before the user
      // finishes speaking. That edge must not erase the pending continuation.
      coordinator.onAssistantOutputStopped();
      coordinator.onInputSpeechStopped();
      await Promise.resolve();
      expect(continueAfterConfirmedSpeech).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels sustained-speech confirmation when a short VAD transient stops first', async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn();
      const interrupt = vi.fn(async () => undefined);
      const coordinator = createRealtimeBargeInCoordinator({
        beginOutputInterruptionCandidate: () => 'retained',
        resolveOutputInterruptionCandidate: resolve,
        interrupt,
        transitionToSpeaking: vi.fn(), transitionToConnected: vi.fn(),
        getControlSessionId: () => 'voice-global', isBargeInEnabled: () => true,
        speechConfirmMs: 800,
        candidateMaxMs: 3_000,
      });
      coordinator.onAssistantOutputStarted();
      coordinator.onInputSpeechStarted();
      await vi.advanceTimersByTimeAsync(300);
      coordinator.onInputSpeechStopped();
      await vi.advanceTimersByTimeAsync(600);

      expect(interrupt).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalledWith('confirmed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues exactly once after a stopped substantive transcript and contains continuation failure', async () => {
    let now = 1_000;
    const onInterruptError = vi.fn();
    const continueAfterConfirmedSpeech = vi.fn(async () => { throw new Error('continue_failed'); });
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'ducked',
      resolveOutputInterruptionCandidate: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      continueAfterConfirmedSpeech,
      onInterruptError,
      transitionToSpeaking: vi.fn(), transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global', isBargeInEnabled: () => true,
      now: () => now,
    });
    coordinator.onAssistantOutputStarted();
    now += 1_500;
    coordinator.onInputSpeechStarted();
    coordinator.onInputSpeechStopped();

    await coordinator.onTranscript({
      role: 'user', type: 'voice.transcript.final', text: 'please answer my new question now',
    });
    coordinator.onInputSpeechStopped();
    coordinator.onAssistantOutputStopped();
    await Promise.resolve();

    expect(continueAfterConfirmedSpeech).toHaveBeenCalledTimes(1);
    expect(onInterruptError).toHaveBeenCalledWith(expect.objectContaining({ message: 'continue_failed' }));
  });

  it('does not create the replacement response until the cancelled output has actually stopped', async () => {
    let now = 1_000;
    const continueAfterConfirmedSpeech = vi.fn(async () => undefined);
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'ducked',
      resolveOutputInterruptionCandidate: vi.fn(),
      interrupt: vi.fn(async () => undefined),
      continueAfterConfirmedSpeech,
      transitionToSpeaking: vi.fn(), transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global', isBargeInEnabled: () => true,
      now: () => now,
    });
    coordinator.onAssistantOutputStarted();
    now += 1_500;
    coordinator.onInputSpeechStarted();
    coordinator.onInputSpeechStopped();
    await coordinator.onTranscript({
      role: 'user', type: 'voice.transcript.final', text: 'please answer this new question',
    });

    expect(continueAfterConfirmedSpeech).not.toHaveBeenCalled();
    coordinator.onAssistantOutputStopped();
    await Promise.resolve();
    expect(continueAfterConfirmedSpeech).toHaveBeenCalledTimes(1);
  });

  it('creates the response for a committed user turn taken while the assistant is idle', async () => {
    const continueAfterConfirmedSpeech = vi.fn(async () => undefined);
    const interrupt = vi.fn(async () => undefined);
    let bargeInEnabled = true;
    const coordinator = createRealtimeBargeInCoordinator({
      beginOutputInterruptionCandidate: () => 'ducked',
      resolveOutputInterruptionCandidate: vi.fn(),
      interrupt,
      continueAfterConfirmedSpeech,
      transitionToSpeaking: vi.fn(), transitionToConnected: vi.fn(),
      getControlSessionId: () => 'voice-global', isBargeInEnabled: () => bargeInEnabled,
    });

    coordinator.onInputSpeechStarted();
    coordinator.onInputSpeechStopped();
    await Promise.resolve();

    expect(interrupt).not.toHaveBeenCalled();
    expect(continueAfterConfirmedSpeech).toHaveBeenCalledTimes(1);

    // Output already in flight is the two-stage gate's business, and with
    // barge-in off no candidate is opened at all; creating a response from the
    // plain path there would talk over the answer already being produced.
    bargeInEnabled = false;
    coordinator.onAssistantOutputStarted();
    coordinator.onInputSpeechStarted();
    coordinator.onInputSpeechStopped();
    await Promise.resolve();

    expect(continueAfterConfirmedSpeech).toHaveBeenCalledTimes(1);
  });
});
