import {
  DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
  resolveBackchannelDecision,
} from '@/voice/runtime/input/resolveBackchannelDecision';
import type {
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

type TranscriptEvent = Readonly<{
  role: 'user' | 'assistant';
  type: string;
  text: string;
  itemId?: string;
  assistantEntryId?: string | null;
}>;

type Deps = Readonly<{
  beginOutputInterruptionCandidate(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void;
  readPlaybackCursorMs?(): number | null;
  onConfirmedInterruption?(input: Readonly<{
    controlSessionId: string;
    playedMs: number;
    assistantEntryId: string | null;
  }>): void;
  interrupt(): Promise<void>;
  continueAfterConfirmedSpeech?(): Promise<void>;
  transitionToSpeaking(controlSessionId: string): void;
  transitionToConnected(controlSessionId: string): void;
  getControlSessionId(): string | null;
  isBargeInEnabled(): boolean;
  onInterruptError?(error: unknown): void;
  now?: () => number;
  candidateMaxMs?: number;
  speechConfirmMs?: number;
  setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}>;

/**
 * Provider-neutral owner of realtime speech/output edges and provisional
 * interruption. Provider adapters only translate their wire events; this
 * coordinator decides whether a user utterance is substantive before the
 * response is destructively cancelled.
 */
export function createRealtimeBargeInCoordinator(deps: Deps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const candidateMaxMs = Math.max(1, Math.floor(
    deps.candidateMaxMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.candidateMaxMs,
  ));
  const speechConfirmMs = Math.max(1, Math.floor(
    deps.speechConfirmMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.endpointHysteresis.confirmMs,
  ));
  let outputStartedAtMs: number | null = null;
  let outputStartedAtPlaybackCursorMs: number | null = null;
  let activeAssistantOutputItemId: string | null = null;
  let activeAssistantEntryId: string | null = null;
  type Candidate = {
    controlSessionId: string;
    speechStartedAtMs: number;
    assistantOutputStartedAtMs: number;
    speechStoppedAtMs: number | null;
    failSafeTimer: ReturnType<typeof setTimeout> | null;
    confirmTimer: ReturnType<typeof setTimeout> | null;
    playedMs: number | null;
    assistantOutputItemId: string | null;
    assistantEntryId: string | null;
  };
  let candidate: Candidate | null = null;
  type ConfirmedTurn = {
    controlSessionId: string;
    speechStopped: boolean;
    outputStopped: boolean;
    interruptSettled: boolean;
    continuationStarted: boolean;
    playedMs: number | null;
    assistantOutputItemId: string | null;
    assistantEntryId: string | null;
    exactInterruptionReported: boolean;
  };
  let confirmedTurn: ConfirmedTurn | null = null;

  const clearCandidate = (resolution: VoicePlaybackInterruptionResolution): boolean => {
    const active = candidate;
    if (!active) return false;
    candidate = null;
    if (active.failSafeTimer !== null) clearTimer(active.failSafeTimer);
    if (active.confirmTimer !== null) clearTimer(active.confirmTimer);
    deps.resolveOutputInterruptionCandidate(resolution);
    return true;
  };

  const maybeContinueConfirmedTurn = async (expected: ConfirmedTurn): Promise<void> => {
    if (confirmedTurn !== expected || !expected.interruptSettled) return;
    if (!deps.continueAfterConfirmedSpeech) {
      if (
        expected.assistantOutputItemId === null
        || expected.assistantEntryId !== null
      ) {
        confirmedTurn = null;
      }
      return;
    }
    if (!expected.speechStopped || !expected.outputStopped || expected.continuationStarted) return;
    expected.continuationStarted = true;
    try {
      await deps.continueAfterConfirmedSpeech();
    } catch (error) {
      deps.onInterruptError?.(error);
    } finally {
      if (
        confirmedTurn === expected
        && (
          expected.assistantOutputItemId === null
          || expected.assistantEntryId !== null
        )
      ) {
        confirmedTurn = null;
      }
    }
  };

  const reportLateExactInterruption = (expected: ConfirmedTurn): void => {
    if (
      confirmedTurn !== expected
      || expected.exactInterruptionReported
      || expected.playedMs === null
      || expected.assistantEntryId === null
    ) {
      return;
    }
    expected.exactInterruptionReported = true;
    deps.onConfirmedInterruption?.({
      controlSessionId: expected.controlSessionId,
      playedMs: expected.playedMs,
      assistantEntryId: expected.assistantEntryId,
    });
    if (
      expected.interruptSettled
      && (
        !deps.continueAfterConfirmedSpeech
        || (
          expected.continuationStarted
          && expected.speechStopped
          && expected.outputStopped
        )
      )
    ) {
      confirmedTurn = null;
    }
  };

  const confirmCandidate = async (expected: Candidate): Promise<void> => {
    if (candidate !== expected) return;
    const shouldInterrupt = outputStartedAtMs !== null;
    const confirmed: ConfirmedTurn = {
      controlSessionId: expected.controlSessionId,
      speechStopped: expected.speechStoppedAtMs !== null,
      outputStopped: !shouldInterrupt,
      interruptSettled: false,
      continuationStarted: false,
      playedMs: expected.playedMs,
      assistantOutputItemId: expected.assistantOutputItemId,
      assistantEntryId: expected.assistantEntryId,
      exactInterruptionReported: expected.assistantEntryId !== null,
    };
    confirmedTurn = confirmed;
    clearCandidate('confirmed');
    if (expected.playedMs !== null) {
      deps.onConfirmedInterruption?.({
        controlSessionId: expected.controlSessionId,
        playedMs: expected.playedMs,
        assistantEntryId: expected.assistantEntryId,
      });
    }
    try {
      if (shouldInterrupt) await deps.interrupt();
    } catch (error) {
      if (confirmedTurn === confirmed) confirmedTurn = null;
      deps.onInterruptError?.(error);
      return;
    }
    if (confirmedTurn !== confirmed) return;
    confirmed.interruptSettled = true;
    await maybeContinueConfirmedTurn(confirmed);
  };

  const reset = (): void => {
    clearCandidate('false_alarm');
    confirmedTurn = null;
    outputStartedAtMs = null;
    outputStartedAtPlaybackCursorMs = null;
    activeAssistantOutputItemId = null;
    activeAssistantEntryId = null;
  };

  return Object.freeze({
    onAssistantOutputStarted(input?: Readonly<{ itemId?: string | null }>): void {
      const controlSessionId = deps.getControlSessionId();
      if (!controlSessionId) return;
      const itemId = typeof input?.itemId === 'string' && input.itemId.trim()
        ? input.itemId.trim()
        : null;
      if (outputStartedAtMs === null) {
        outputStartedAtMs = now();
        const cursor = deps.readPlaybackCursorMs?.();
        outputStartedAtPlaybackCursorMs = typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0
          ? cursor
          : null;
        activeAssistantOutputItemId = itemId;
        activeAssistantEntryId = null;
      } else if (activeAssistantOutputItemId === null && itemId !== null) {
        // Some providers announce remote audio before they can name its
        // transcript item. This is the same active output acquiring its exact
        // persistence correlation, not a second output authority.
        activeAssistantOutputItemId = itemId;
        activeAssistantEntryId = null;
        if (candidate) {
          candidate.assistantOutputItemId = itemId;
          candidate.assistantEntryId = null;
        }
      } else if (itemId !== activeAssistantOutputItemId) {
        // Concurrent/overlapping output cannot be attributed to one persisted
        // final. Keep the acoustic lifecycle active but fail identity closed.
        activeAssistantOutputItemId = null;
        activeAssistantEntryId = null;
        if (candidate) {
          candidate.assistantOutputItemId = null;
          candidate.assistantEntryId = null;
        }
      }
      deps.transitionToSpeaking(controlSessionId);
    },
    onAssistantOutputStopped(): void {
      const controlSessionId = deps.getControlSessionId();
      clearCandidate('false_alarm');
      outputStartedAtMs = null;
      outputStartedAtPlaybackCursorMs = null;
      activeAssistantOutputItemId = null;
      activeAssistantEntryId = null;
      const confirmed = confirmedTurn;
      if (confirmed && !confirmed.outputStopped) {
        confirmed.outputStopped = true;
        void maybeContinueConfirmedTurn(confirmed);
      }
      if (controlSessionId) deps.transitionToConnected(controlSessionId);
    },
    onInputSpeechStarted(): void {
      const controlSessionId = deps.getControlSessionId();
      if (!controlSessionId || outputStartedAtMs === null || !deps.isBargeInEnabled()) return;
      if (candidate?.controlSessionId === controlSessionId) return;
      clearCandidate('false_alarm');
      deps.beginOutputInterruptionCandidate();
      const cursorAtSpeechOnset = deps.readPlaybackCursorMs?.();
      const playedMs = outputStartedAtPlaybackCursorMs !== null
        && typeof cursorAtSpeechOnset === 'number'
        && Number.isFinite(cursorAtSpeechOnset)
        ? Math.max(0, cursorAtSpeechOnset - outputStartedAtPlaybackCursorMs)
        : null;
      const speechStartedAtMs = now();
      const nextCandidate: Candidate = {
        controlSessionId,
        speechStartedAtMs,
        assistantOutputStartedAtMs: outputStartedAtMs,
        speechStoppedAtMs: null,
        failSafeTimer: null,
        confirmTimer: null,
        playedMs,
        assistantOutputItemId: activeAssistantOutputItemId,
        assistantEntryId: activeAssistantEntryId,
      };
      candidate = nextCandidate;
      nextCandidate.failSafeTimer = setTimer(() => {
        if (candidate === nextCandidate) {
          clearCandidate('false_alarm');
        }
      }, candidateMaxMs);
      nextCandidate.confirmTimer = setTimer(() => {
        void confirmCandidate(nextCandidate).catch((error) => deps.onInterruptError?.(error));
      }, speechConfirmMs);
    },
    onInputSpeechStopped(): void {
      if (candidate && candidate.speechStoppedAtMs === null) {
        candidate.speechStoppedAtMs = now();
        if (candidate.confirmTimer !== null) {
          clearTimer(candidate.confirmTimer);
          candidate.confirmTimer = null;
        }
        return;
      }
      const confirmed = confirmedTurn;
      if (confirmed) {
        if (confirmed.speechStopped) return;
        confirmed.speechStopped = true;
        void maybeContinueConfirmedTurn(confirmed);
        return;
      }
      // A provider that hands response creation to the client answers no turn
      // on its own. Nothing was interrupted here, so the two-stage gate never
      // runs and this plain committed turn still needs its response created.
      // While output is active the gate owns that decision instead, so the
      // same turn is never answered twice.
      if (candidate || outputStartedAtMs !== null || !deps.continueAfterConfirmedSpeech) return;
      void deps.continueAfterConfirmedSpeech().catch((error) => deps.onInterruptError?.(error));
    },
    async onTranscript(event: TranscriptEvent): Promise<void> {
      if (
        event.role === 'assistant'
        && event.type === 'voice.transcript.final'
      ) {
        const assistantEntryId =
          typeof event.assistantEntryId === 'string' && event.assistantEntryId.trim()
            ? event.assistantEntryId.trim()
            : null;
        if (
          activeAssistantOutputItemId !== null
          && event.itemId === activeAssistantOutputItemId
        ) {
          activeAssistantEntryId = assistantEntryId;
          if (candidate?.assistantOutputItemId === activeAssistantOutputItemId) {
            candidate.assistantEntryId = activeAssistantEntryId;
          }
        }
        const confirmed = confirmedTurn;
        if (
          confirmed
          && confirmed.assistantOutputItemId !== null
          && event.itemId === confirmed.assistantOutputItemId
        ) {
          confirmed.assistantEntryId = assistantEntryId;
          reportLateExactInterruption(confirmed);
        }
        return;
      }
      const active = candidate;
      if (!active || event.role !== 'user' || event.type !== 'voice.transcript.final') return;
      const speakingElapsedMs = Math.max(0, active.speechStartedAtMs - active.assistantOutputStartedAtMs);
      const durationMs = active.speechStoppedAtMs === null
        ? null
        : Math.max(0, active.speechStoppedAtMs - active.speechStartedAtMs);
      const decision = resolveBackchannelDecision({
        config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
        transcript: event.text,
        durationMs,
        speaking: { speakingElapsedMs },
      });
      if (decision.isBackchannel) {
        clearCandidate('false_alarm');
        return;
      }
      await confirmCandidate(active);
    },
    reset,
  });
}
