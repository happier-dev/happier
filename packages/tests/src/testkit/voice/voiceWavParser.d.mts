export type VoiceWavFormat = Readonly<{
  audioFormat: number;
  channelCount: number;
  sampleRateHz: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}>;

export type VoiceWavContainer = Readonly<{
  format: VoiceWavFormat;
  dataBytes: Uint8Array;
  dataOffset: number;
}>;

export declare function parseVoiceWavContainer(
  bytes: Uint8Array,
  id?: string,
): VoiceWavContainer;
