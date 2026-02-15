import { encodeBase64 } from '@/encryption/base64';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';

export type GoogleGeminiSttAudio =
  | { kind: 'native'; uri: string; mimeType: string }
  | { kind: 'web'; blob: Blob; mimeType: string };

async function loadAudioBase64(audio: GoogleGeminiSttAudio): Promise<string> {
  if (audio.kind === 'native') {
    const FileSystem: any = await import('expo-file-system');
    return await FileSystem.readAsStringAsync(audio.uri, { encoding: FileSystem.EncodingType.Base64 });
  }

  const buffer = await audio.blob.arrayBuffer();
  return encodeBase64(new Uint8Array(buffer), 'base64');
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
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            {
              inline_data: {
                mime_type: opts.audio.mimeType,
                data: audioBase64,
              },
            },
          ],
        },
      ],
    }),
  };

  const res = await fetchWithTimeout(url, init, opts.timeoutMs, 'stt_timeout');
  if (!res.ok) {
    throw new Error(`google_gemini_stt_failed:${res.status}`);
  }

  const json = await res.json().catch(() => null);
  return extractTranscript(json);
}
