import { encodeBase64 } from '@/encryption/base64';
import { SttRequestError } from '@/voice/input/sttRequestError';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';
import { buildGoogleApiKeyRestrictionHeaders } from '@/voice/runtime/googleApiKeyHeaders';

export type GoogleGeminiSttAudio =
  | { kind: 'native'; uri: string; mimeType: string }
  | { kind: 'web'; blob: Blob; mimeType: string };

async function loadAudioBase64(audio: GoogleGeminiSttAudio): Promise<string> {
  if (audio.kind === 'native') {
    const { File } = await import('expo-file-system');
    return await new File(audio.uri).base64();
  }

  const buffer = await audio.blob.arrayBuffer();
  return encodeBase64(new Uint8Array(buffer), 'base64');
}

/**
 * Gemini accepts bare MIME types from its documented list (ai.google.dev/gemini-api/docs/audio):
 * codec parameters are dropped, and AAC-in-MP4 recordings (expo-audio `.m4a`, Safari
 * MediaRecorder `audio/mp4`) are sent as the documented `audio/m4a`.
 */
export function normalizeGeminiAudioMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/m4a') return 'audio/m4a';
  return base || 'audio/m4a';
}

/**
 * Transcription needs no reasoning. Gemini 2.5 Flash/Flash-Lite think by default and document
 * `thinkingBudget: 0` as "disable thinking"; 2.5 Pro rejects 0 and Gemini 3+ use `thinkingLevel`
 * (ai.google.dev/gemini-api/docs/thinking), so other models keep their default.
 */
// Text-output 2.5 Flash / Flash-Lite ids, optionally a dated preview. Image, TTS, live and
// native-audio variants are different products and keep their defaults.
const TRANSCRIPTION_FLASH_MODEL = /^gemini-2\.5-flash(?:-lite)?(?:-preview-\d{2}-\d{2,4})?$/;

function resolveTranscriptionGenerationConfig(model: string): { thinkingConfig: { thinkingBudget: number } } | undefined {
  return TRANSCRIPTION_FLASH_MODEL.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : undefined;
}

async function readGeminiErrorReason(res: Response): Promise<string | null> {
  const json = await res.json().catch(() => null);
  const details: unknown[] = Array.isArray(json?.error?.details) ? json.error.details : [];
  for (const detail of details) {
    if (detail && typeof detail === 'object' && 'reason' in detail && typeof detail.reason === 'string') {
      return detail.reason;
    }
  }
  return null;
}

function extractTranscript(json: any): string | null {
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  const first = candidates[0];
  const parts = Array.isArray(first?.content?.parts) ? first.content.parts : [];
  for (const part of parts) {
    const text = typeof part?.text === 'string' ? part.text.trim() : '';
    if (text) return text;
  }
  return null;
}

export async function transcribeWithGoogleGeminiStt(opts: {
  apiKey: string;
  model: string;
  audio: GoogleGeminiSttAudio;
  language?: string | null;
  androidCertSha1?: string | null;
  timeoutMs: number;
}): Promise<string | null> {
  const apiKey = String(opts.apiKey ?? '').trim();
  const rawModel = String(opts.model ?? '').trim();
  const model = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
  if (!apiKey) throw new Error('google_gemini_stt_missing_api_key');
  if (!model) throw new Error('google_gemini_stt_missing_model');

  const audioBase64 = await loadAudioBase64(opts.audio);
  if (!audioBase64) throw new Error('google_gemini_stt_missing_audio');

  const instruction =
    typeof opts.language === 'string' && opts.language.trim().length > 0
      ? `Transcribe this audio. Language: ${opts.language.trim()}. Return only the transcript text.`
      : 'Transcribe this audio. Return only the transcript text.';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      ...buildGoogleApiKeyRestrictionHeaders({ androidCertSha1: opts.androidCertSha1 ?? null }),
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            {
              inline_data: {
                mime_type: normalizeGeminiAudioMimeType(opts.audio.mimeType),
                data: audioBase64,
              },
            },
          ],
        },
      ],
      generationConfig: resolveTranscriptionGenerationConfig(model),
    }),
  };

  const res = await fetchWithTimeout(url, init, opts.timeoutMs, 'stt_timeout');
  if (!res.ok) {
    // Gemini answers an invalid API key with 400 + reason API_KEY_INVALID rather than 401.
    const reason = await readGeminiErrorReason(res);
    throw new SttRequestError({
      provider: 'google_gemini',
      status: res.status,
      ...(reason === 'API_KEY_INVALID' ? { code: 'stt_auth_failed' as const } : {}),
    });
  }

  const json = await res.json().catch(() => null);
  return extractTranscript(json);
}
