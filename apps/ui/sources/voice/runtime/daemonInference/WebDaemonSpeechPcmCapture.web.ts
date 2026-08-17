import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import {
  createWebPcmCapture,
  type WebPcmCaptureError,
} from '@/voice/runtime/input/WebPcmCapture.web';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

export type WebDaemonSpeechPcmCaptureOptions = Readonly<{
  micSession: MicSession;
  onAudioStarted: () => void;
  onChunk: (pcm16Bytes: Uint8Array) => Promise<void>;
  onError?: (error: ReturnType<typeof createVoiceMachineError>) => void;
  onFallbackActivated?: (kind: 'script_processor') => void;
  signal?: AbortSignal | null;
  processorBufferSize?: number;
  maxQueuedChunks?: number;
}>;

export type WebDaemonSpeechPcmCapture = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForDrain(): Promise<void>;
  isActive(): boolean;
}>;

const FRAME_MS = 20;

function mapCaptureError(error: WebPcmCaptureError): string {
  switch (error) {
    case 'pcm_capture_backpressure':
      return 'daemon_streaming_stt_pcm_backpressure';
    case 'pcm_capture_chunk_failed':
      return 'daemon_streaming_stt_pcm_chunk_failed';
    case 'pcm_capture_device_lost':
      return 'daemon_streaming_stt_web_mic_device_lost';
    case 'pcm_capture_invalid_chunk':
      return 'daemon_streaming_stt_pcm_invalid_chunk';
    case 'pcm_capture_media_source_failed':
      return 'daemon_streaming_stt_web_mic_media_source_failed';
    case 'pcm_capture_mic_acquisition_failed':
      return 'daemon_streaming_stt_web_mic_acquisition_failed';
    case 'pcm_capture_mic_state_unavailable':
      return 'daemon_streaming_stt_web_mic_state_unavailable';
    case 'pcm_capture_resume_failed':
      return 'daemon_streaming_stt_pcm_capture_resume_failed';
    case 'pcm_capture_unavailable':
      return 'daemon_streaming_stt_pcm_capture_unavailable';
  }
}

export function createWebDaemonSpeechPcmCapture(
  options: WebDaemonSpeechPcmCaptureOptions,
): WebDaemonSpeechPcmCapture {
  let audioStarted = false;

  return createWebPcmCapture({
    mic: options.micSession,
    format: {
      sampleRate: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz,
      channels: VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount,
      encoding: 'pcm16le',
    },
    chunkMs: FRAME_MS,
    fallback: 'allow_script_processor',
    processorBufferSize: options.processorBufferSize,
    maxQueuedChunks: options.maxQueuedChunks,
    onFallbackActivated: options.onFallbackActivated,
    signal: options.signal,
    async onChunk({ bytes }) {
      if (!audioStarted) {
        audioStarted = true;
        options.onAudioStarted();
      }
      await options.onChunk(bytes);
    },
    onError(error) {
      options.onError?.(createVoiceMachineError({
        kind: 'provider_error',
        reason: mapCaptureError(error),
      }));
    },
  });
}
