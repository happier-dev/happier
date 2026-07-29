export type AudioStreamFrameEvent = Readonly<{
  streamId: string;
  pcm16leBase64: string;
  sampleRate: number;
  channels: number;
}>;

import type {
  VoiceAudioSessionApplyRequest,
  VoiceAudioSessionApplyResult,
  VoiceAudioSessionPlatformEvent,
} from './voiceAudioSessionCoordinator';

export type HappierAudioStreamNativeEventMap = Readonly<{
  audioFrame: AudioStreamFrameEvent;
  voiceAudioSessionEvent: VoiceAudioSessionPlatformEvent;
}>;

export type HappierAudioStreamNativeModule = Readonly<{
  start: (params: { sampleRate: number; channels: number; frameMs: number }) => Promise<{ streamId: string }>;
  stop: (params: { streamId: string }) => Promise<void>;
  configureAudioSession: (request: VoiceAudioSessionApplyRequest) => Promise<VoiceAudioSessionApplyResult>;
  restoreAudioSession: (request: Readonly<{ generation: number }>) => Promise<void>;
  addListener: <EventName extends keyof HappierAudioStreamNativeEventMap>(
    eventName: EventName,
    cb: (event: HappierAudioStreamNativeEventMap[EventName]) => void,
  ) => Readonly<{ remove: () => void }>;
}>;
