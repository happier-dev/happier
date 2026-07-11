import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

type VoiceConnectionCloseReason = Readonly<{
  code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error';
  detail?: string;
}>;

type AttemptResourcePort = Readonly<{
  prepare: (input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>) => Promise<void>;
  release: (input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: VoiceConnectionCloseReason;
  }>) => Promise<void>;
}>;

function readRequest(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : {};
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('voice_attempt_aborted'), { name: 'AbortError' });
  }
}

export function createElevenLabsAttemptResources(input: Readonly<{
  mic: Readonly<{
    ensureActive: () => Promise<void>;
    teardown: () => Promise<void>;
    setMuted: (muted: boolean) => void;
  }>;
  transitionToAcquiringMic: (controlSessionId: string) => void;
  ensureBound: (input: Readonly<{
    adapterId: string;
    controlSessionId: string;
    requestedTargetSessionId: string | null;
  }>) => Promise<unknown>;
  enableAudioMode: () => Promise<void>;
  disableAudioMode: () => Promise<void>;
}>): Readonly<{
  port: AttemptResourcePort;
  setMuted: (muted: boolean) => void;
}> {
  let micActive = false;
  let audioModeActive = false;

  const port: AttemptResourcePort = {
    async prepare({ controlSessionId, request, signal }) {
      const config = readRequest(request);
      if (config.textOnly !== true) {
        input.transitionToAcquiringMic(controlSessionId);
        micActive = true;
        await input.mic.ensureActive();
        abortIfRequested(signal);
      }
      const requestedTargetSessionId = typeof config.requestedTargetSessionId === 'string'
        && config.requestedTargetSessionId.trim()
        ? config.requestedTargetSessionId.trim()
        : null;
      await input.ensureBound({
        adapterId: 'realtime_elevenlabs',
        controlSessionId,
        requestedTargetSessionId,
      });
      abortIfRequested(signal);
      audioModeActive = true;
      await input.enableAudioMode();
      abortIfRequested(signal);
    },
    async release() {
      const shouldTeardownMic = micActive;
      const shouldDisableAudioMode = audioModeActive;
      micActive = false;
      audioModeActive = false;
      if (shouldTeardownMic) await input.mic.teardown().catch(() => {});
      if (shouldDisableAudioMode) await input.disableAudioMode().catch(() => {});
    },
  };

  return Object.freeze({
    port,
    setMuted(muted: boolean) {
      input.mic.setMuted(muted);
    },
  });
}
