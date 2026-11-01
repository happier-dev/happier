export type AudioStreamFrameEvent = Readonly<{
  streamId: string;
  pcm16leBase64: string;
  sampleRate: number;
  channels: number;
}>;

/** Capture stopped producing audio; the stream will emit no further frames until restarted. */
export type AudioStreamErrorEvent = Readonly<{
  streamId: string;
  code: 'read_failed' | 'capture_failed' | 'conversion_failed';
  message: string;
}>;

export type HappierAudioStreamNativeModule = Readonly<{
  start: (params: { sampleRate: number; channels: number; frameMs: number }) => Promise<{ streamId: string }>;
  stop: (params: { streamId: string }) => Promise<void>;
  addListener: {
    (eventName: 'audioFrame', cb: (event: AudioStreamFrameEvent) => void): Readonly<{ remove: () => void }>;
    (eventName: 'audioError', cb: (event: AudioStreamErrorEvent) => void): Readonly<{ remove: () => void }>;
  };
}>;

