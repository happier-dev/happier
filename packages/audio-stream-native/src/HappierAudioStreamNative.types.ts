export type AudioStreamFrameEvent = Readonly<{
  streamId: string;
  pcm16leBase64: string;
  sampleRate: number;
  channels: number;
}>;

export type HappierAudioStreamNativeModule = Readonly<{
  start: (params: { sampleRate: number; channels: number; frameMs: number }) => Promise<{ streamId: string }>;
  stop: (params: { streamId: string }) => Promise<void>;
  addListener: (
    eventName: 'audioFrame',
    cb: (event: AudioStreamFrameEvent) => void,
  ) => Readonly<{ remove: () => void }>;
}>;

