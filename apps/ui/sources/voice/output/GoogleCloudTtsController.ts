import { decodeBase64 } from '@/encryption/base64';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';
import { buildGoogleApiKeyRestrictionHeaders } from '@/voice/runtime/googleApiKeyHeaders';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { speakBufferedSpeech } from '@/voice/output/speakBufferedSpeech';

// https://cloud.google.com/text-to-speech/quotas: input.text has a hard 5000-byte limit.
const GOOGLE_CLOUD_TTS_MAX_INPUT_BYTES = 5000;

/**
 * Speaks text with Google Cloud TTS. Resolves when playback finishes or is deliberately stopped
 * (including while a request is in flight); rejects only on a real failure.
 */
export async function speakGoogleCloudText(opts: {
  apiKey: string;
  androidCertSha1?: string | null;
  input: string;
  readAloudChunkChars?: number;
  voiceName: string | null;
  languageCode: string | null;
  format: 'mp3' | 'wav';
  speakingRate: number | null;
  pitch: number | null;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  return speakBufferedSpeech({
    ...opts,
    maxInputUtf8Bytes: GOOGLE_CLOUD_TTS_MAX_INPUT_BYTES,
    fetchAudio: (input, signal) => fetchGoogleCloudSpeechAudio({ ...opts, input, signal }),
  });
}

async function fetchGoogleCloudSpeechAudio(opts: {
  apiKey: string;
  androidCertSha1?: string | null;
  input: string;
  voiceName: string | null;
  languageCode: string | null;
  format: 'mp3' | 'wav';
  speakingRate: number | null;
  pitch: number | null;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ArrayBuffer> {
  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('google_cloud_tts_missing_api_key');
  }

  const audioEncoding = opts.format === 'wav' ? 'LINEAR16' : 'MP3';
  const voice: Record<string, unknown> = {};
  if (opts.languageCode) voice.languageCode = opts.languageCode;
  if (opts.voiceName) voice.name = opts.voiceName;

  const audioConfig: Record<string, unknown> = {
    audioEncoding,
  };
  if (opts.speakingRate != null) audioConfig.speakingRate = opts.speakingRate;
  if (opts.pitch != null) audioConfig.pitch = opts.pitch;

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;
  const init: RequestInit = {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      ...buildGoogleApiKeyRestrictionHeaders({ androidCertSha1: opts.androidCertSha1 ?? null }),
    },
    body: JSON.stringify({
      input: { text: opts.input },
      voice,
      audioConfig,
    }),
  };

  const json: unknown = await fetchWithTimeout(url, init, opts.timeoutMs, 'tts_timeout', async (response) => {
    if (!response.ok) throw new Error(`google_cloud_tts_failed:${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  });
  const audioContent = json && typeof json === 'object' && 'audioContent' in json && typeof json.audioContent === 'string'
    ? json.audioContent
    : null;
  if (!audioContent) {
    throw new Error('google_cloud_tts_missing_audio_content');
  }

  const decoded = decodeBase64(audioContent, 'base64');
  // Ensure we return a standalone ArrayBuffer (avoid SharedArrayBuffer unions leaking through Uint8Array.buffer typing).
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes.buffer;
}
