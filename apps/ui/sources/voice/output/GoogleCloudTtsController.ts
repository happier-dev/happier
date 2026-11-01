import { decodeBase64 } from '@/encryption/base64';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';
import { buildGoogleApiKeyRestrictionHeaders } from '@/voice/runtime/googleApiKeyHeaders';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createStoppableSpeech } from '@/voice/output/stoppableSpeech';

// https://cloud.google.com/text-to-speech/quotas: input.text has a hard 5000-byte limit.
const GOOGLE_CLOUD_TTS_MAX_INPUT_BYTES = 5000;

function splitGoogleCloudTtsInput(input: string): string[] {
  const batches: string[] = [];
  let remaining = input.trim();
  while (remaining) {
    let end = 0;
    let bytes = 0;
    let wordEnd = 0;
    for (const character of remaining) {
      const point = character.codePointAt(0)!;
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes + size > GOOGLE_CLOUD_TTS_MAX_INPUT_BYTES) break;
      bytes += size;
      end += character.length;
      if (/\s/u.test(character)) wordEnd = end;
    }
    // This input is already spoken text. Markdown-looking literals must never override the API cap.
    const cut = end < remaining.length && wordEnd > 0 ? wordEnd : end;
    batches.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return batches;
}

/**
 * Speaks text with Google Cloud TTS. Resolves when playback finishes or is deliberately stopped
 * (including while a request is in flight); rejects only on a real failure.
 */
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
  const speech = createStoppableSpeech(opts.registerPlaybackStopper);
  try {
    for (const input of splitGoogleCloudTtsInput(opts.input)) {
      const bytes = await fetchGoogleCloudSpeechAudio({ ...opts, input, signal: speech.signal });
      if (speech.signal.aborted) return;
      await playAudioBytesWithStopper({
        bytes,
        format: opts.format,
        registerPlaybackStopper: speech.registerPlayback,
      });
      if (speech.signal.aborted) return;
    }
  } catch (error) {
    if (speech.signal.aborted) return;
    throw error;
  } finally {
    speech.dispose();
  }
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
