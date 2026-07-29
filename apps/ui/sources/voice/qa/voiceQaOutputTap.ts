import { isVoiceQaDebugRuntime } from '@/voice/qa/voiceQaDebugRuntime';

export type VoiceQaOutputLifecycle =
  | 'scheduled'
  | 'playing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type VoiceQaOutputArtifact = Readonly<{
  id: number;
  format: 'mp3' | 'wav';
  originalByteLength: number;
  capturedByteLength: number;
  truncated: boolean;
  lifecycle: VoiceQaOutputLifecycle;
  bytesBase64: string | null;
  errorCode: string | null;
}>;

export type VoiceQaOutputTapSnapshot = Readonly<{
  enabled: boolean;
  artifact: VoiceQaOutputArtifact | null;
}>;

export type VoiceQaOutputTapHandle = Readonly<{
  markPlaying: () => void;
  markCompleted: () => void;
  markCancelled: () => void;
  markFailed: (errorCode?: string) => void;
}>;

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DISABLED_SNAPSHOT: VoiceQaOutputTapSnapshot = Object.freeze({
  enabled: false,
  artifact: null,
});
const NOOP_HANDLE: VoiceQaOutputTapHandle = Object.freeze({
  markPlaying: () => {},
  markCompleted: () => {},
  markCancelled: () => {},
  markFailed: () => {},
});

let snapshot: VoiceQaOutputTapSnapshot = DISABLED_SNAPSHOT;
let sequence = 0;
const listeners = new Set<() => void>();

function publish(next: VoiceQaOutputTapSnapshot): void {
  snapshot = Object.freeze(next);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // QA observation must never influence the playback path it observes.
    }
  }
}

function updateArtifact(id: number, update: (current: VoiceQaOutputArtifact) => VoiceQaOutputArtifact): void {
  const current = snapshot.artifact;
  if (!snapshot.enabled || !current || current.id !== id) return;
  publish({ enabled: true, artifact: Object.freeze(update(current)) });
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 16_384;
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function setVoiceQaOutputTapEnabled(enabled: boolean): void {
  if (!enabled || !isVoiceQaDebugRuntime()) {
    publish(DISABLED_SNAPSHOT);
    return;
  }
  if (snapshot.enabled) return;
  publish({ enabled: true, artifact: null });
}

export function beginVoiceQaOutputTap(params: Readonly<{
  bytes: ArrayBuffer;
  format: 'mp3' | 'wav';
}>): VoiceQaOutputTapHandle {
  if (!snapshot.enabled || !isVoiceQaDebugRuntime()) return NOOP_HANDLE;

  const id = ++sequence;
  const captureLength = Math.min(params.bytes.byteLength, MAX_CAPTURE_BYTES);
  const artifact: VoiceQaOutputArtifact = Object.freeze({
    id,
    format: params.format,
    originalByteLength: params.bytes.byteLength,
    capturedByteLength: captureLength,
    truncated: captureLength < params.bytes.byteLength,
    lifecycle: 'scheduled',
    bytesBase64: null,
    errorCode: null,
  });
  publish({ enabled: true, artifact });

  // Copy/encode after the caller schedules hardware playback. The tap's call
  // site stays at the canonical sink, but QA work cannot delay audio start.
  queueMicrotask(() => {
    try {
      const captured = new Uint8Array(params.bytes, 0, captureLength).slice();
      const bytesBase64 = bytesToBase64(captured);
      updateArtifact(id, (current) => ({ ...current, bytesBase64 }));
    } catch {
      updateArtifact(id, (current) => ({
        ...current,
        lifecycle: 'failed',
        bytesBase64: null,
        errorCode: 'voice_qa_output_capture_failed',
      }));
    }
  });

  const markLifecycle = (lifecycle: VoiceQaOutputLifecycle, errorCode: string | null = null) => {
    updateArtifact(id, (current) => {
      if (
        current.lifecycle === 'completed'
        || current.lifecycle === 'cancelled'
        || current.lifecycle === 'failed'
      ) {
        return current;
      }
      return { ...current, lifecycle, errorCode };
    });
  };

  return Object.freeze({
    markPlaying: () => markLifecycle('playing'),
    markCompleted: () => markLifecycle('completed'),
    markCancelled: () => markLifecycle('cancelled'),
    markFailed: (errorCode = 'audio_playback_failed') => markLifecycle('failed', errorCode),
  });
}

export function getVoiceQaOutputTapSnapshot(): VoiceQaOutputTapSnapshot {
  return snapshot;
}

export function subscribeToVoiceQaOutputTap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetVoiceQaOutputTapForTests(): void {
  sequence = 0;
  snapshot = DISABLED_SNAPSHOT;
  listeners.clear();
}
