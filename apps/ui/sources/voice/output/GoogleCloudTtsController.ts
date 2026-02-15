import { decodeBase64 } from '@/encryption/base64';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';
import { buildGoogleApiKeyRestrictionHeaders } from '@/voice/runtime/googleApiKeyHeaders';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';

export async function speakGoogleCloudText(opts: {
  apiKey: string;
  androidCertSha1?: string | null;
  input: string;
  voiceName: string | null;
  languageCode: string | null;
  format: 'mp3' | 'wav';
  speakingRate: number | null;
  pitch: number | null;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  const bytes = await fetchGoogleCloudSpeechAudio(opts);
  await playAudioBytesWithStopper({
    bytes,
    format: opts.format,
    registerPlaybackStopper: opts.registerPlaybackStopper,
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

  const res = await fetchWithTimeout(url, init, opts.timeoutMs, 'tts_timeout');
  if (!res.ok) {
    throw new Error(`google_cloud_tts_failed:${res.status}`);
  }

  const json = await res.json().catch(() => null);
  const audioContent = json && typeof (json as any).audioContent === 'string' ? (json as any).audioContent : null;
  if (!audioContent) {
    throw new Error('google_cloud_tts_missing_audio_content');
  }

  const decoded = decodeBase64(audioContent, 'base64');
  // Ensure we return a standalone ArrayBuffer (avoid SharedArrayBuffer unions leaking through Uint8Array.buffer typing).
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes.buffer;
}
