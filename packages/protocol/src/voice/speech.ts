import type { JsonValue } from '../json/strictJsonValue.js';
import type { VoiceSpeechInputMimeType } from '../plugins/contributions/voiceProviders.js';

/**
 * Provider-neutral speech invocation data. The Plugin SDK supplies the
 * credential and HTTP authority appropriate to its daemon realm.
 */
export type VoiceSpeechOperationContext<TCredentials, THttp> = Readonly<{
  credentials: TCredentials;
  settings: Readonly<Record<string, JsonValue>>;
  http: THttp;
  signal: AbortSignal;
}>;

export type VoiceSpeechTranscribeRequest = Readonly<{
  requestId: string;
  model: string;
  language: string | null;
  mimeType: VoiceSpeechInputMimeType;
  bytes: Uint8Array;
}>;

export type VoiceSpeechTranscribeResult = Readonly<{
  requestId: string;
  text: string;
}>;

export type VoiceSpeechSynthesizeRequest = Readonly<{
  requestId: string;
  input: string;
  model: string | null;
  voiceName: string;
  languageCode: string | null;
  format: 'mp3' | 'wav';
  speakingRate: number | null;
  pitch: number | null;
}>;

export type VoiceSpeechSynthesizeResult = Readonly<{
  requestId: string;
  bytes: Uint8Array;
  mimeType: 'audio/mpeg' | 'audio/wav';
}>;
