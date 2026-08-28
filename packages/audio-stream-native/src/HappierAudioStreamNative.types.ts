export type AudioStreamFrameEvent = Readonly<{
  streamId: string;
  pcm16leBase64: string;
  sampleRate: number;
  channels: number;
}>;

export type AudioStreamCaptureTerminalEvent = Readonly<{
  streamId: string;
  generation: number;
  reason: 'read_error' | 'dead_object';
}>;

/**
 * Playback events always carry the active native capture identity. This makes
 * late callbacks from a released/replaced player harmless at the JS boundary.
 */
export type AudioStreamPlaybackDrainedEvent = Readonly<{
  streamId: string;
  generation: number;
}>;

export type AudioStreamPlaybackLevelEvent = Readonly<{
  streamId: string;
  generation: number;
  level: number;
}>;

export type AudioStreamPlaybackTerminalEvent = Readonly<{
  streamId: string;
  generation: number;
  reason: 'write_error' | 'player_error';
}>;

export type VoiceFileRecordingStopResult = Readonly<{
  uri: string;
}>;

export type VoiceEncodedAudioPlaybackEvent = Readonly<{
  playbackId: string;
  status: 'started' | 'finished' | 'failed';
  reason?: string;
}>;

import type {
  VoiceAudioSessionApplyRequest,
  VoiceAudioSessionApplyResult,
  VoiceAudioSessionPlatformEvent,
} from './voiceAudioSessionCoordinator';

export type HappierAudioStreamNativeEventMap = Readonly<{
  audioFrame: AudioStreamFrameEvent;
  captureTerminal: AudioStreamCaptureTerminalEvent;
  playbackDrained: AudioStreamPlaybackDrainedEvent;
  playbackLevel: AudioStreamPlaybackLevelEvent;
  playbackTerminal: AudioStreamPlaybackTerminalEvent;
  encodedAudioPlayback: VoiceEncodedAudioPlaybackEvent;
  voiceAudioSessionEvent: VoiceAudioSessionPlatformEvent;
}>;

export type HappierAudioStreamNativeModule = Readonly<{
  start: (params: { sampleRate: number; channels: number; frameMs: number; generation: number }) => Promise<{ streamId: string }>;
  stop: (params: { streamId: string }) => Promise<void>;
  /** Optional while previously shipped capture-only native modules remain supported. */
  startPlayback?: (params: {
    streamId: string;
    generation: number;
    sampleRate: number;
    channels: number;
    maxBufferedMs: number;
  }) => Promise<{ streamId: string; generation: number }>;
  /** Synchronous so realtime provider callbacks can apply native backpressure. */
  enqueuePlayback?: (params: {
    streamId: string;
    generation: number;
    pcm16leBase64: string;
  }) => { accepted: boolean; level: number };
  clearPlayback?: (params: { streamId: string; generation: number }) => void;
  stopPlayback?: (params: { streamId: string; generation: number }) => Promise<void>;
  setPlaybackGain?: (params: { streamId: string; generation: number; gain: number }) => void;
  /** Returns actual rendered PCM time for this exact player attachment. */
  getPlaybackCursorMs?: (params: { streamId: string; generation: number }) => number;
  configureAudioSession: (request: VoiceAudioSessionApplyRequest) => Promise<VoiceAudioSessionApplyResult>;
  restoreAudioSession: (request: Readonly<{ generation: number }>) => Promise<void>;
  /** Optional while an older installed native module is paired with current JS. */
  startFileRecording?: (params: Readonly<{ format: 'm4a' }>) => Promise<Readonly<{ recordingId: string }>>;
  setFileRecordingMuted?: (params: Readonly<{ recordingId: string; muted: boolean }>) => Promise<void>;
  stopFileRecording?: (params: Readonly<{ recordingId: string }>) => Promise<VoiceFileRecordingStopResult>;
  /** Optional while an older installed native module is paired with current JS. */
  startEncodedAudioPlayback?: (params: Readonly<{ playbackId: string; uri: string }>) => Promise<void>;
  setEncodedAudioPlaybackPaused?: (params: Readonly<{ playbackId: string; paused: boolean }>) => Promise<void>;
  stopEncodedAudioPlayback?: (params: Readonly<{ playbackId: string }>) => Promise<void>;
  addListener: <EventName extends keyof HappierAudioStreamNativeEventMap>(
    eventName: EventName,
    cb: (event: HappierAudioStreamNativeEventMap[EventName]) => void,
  ) => Readonly<{ remove: () => void }>;
}>;

export type HappierAudioStreamNativePlaybackModule = HappierAudioStreamNativeModule & Required<Pick<
  HappierAudioStreamNativeModule,
  'startPlayback' | 'enqueuePlayback' | 'clearPlayback' | 'stopPlayback' | 'setPlaybackGain' | 'getPlaybackCursorMs'
>>;

export type HappierAudioStreamNativeFileRecordingModule = HappierAudioStreamNativeModule & Required<Pick<
  HappierAudioStreamNativeModule,
  'startFileRecording' | 'setFileRecordingMuted' | 'stopFileRecording'
>>;

export type HappierAudioStreamNativeEncodedPlaybackModule = HappierAudioStreamNativeModule & Required<Pick<
  HappierAudioStreamNativeModule,
  'startEncodedAudioPlayback' | 'setEncodedAudioPlaybackPaused' | 'stopEncodedAudioPlayback'
>>;
