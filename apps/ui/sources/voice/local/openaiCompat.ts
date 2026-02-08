export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';

  // Remove trailing slashes.
  const noTrailing = trimmed.replace(/\/+$/, '');

  if (noTrailing.endsWith('/v1')) return noTrailing;
  return `${noTrailing}/v1`;
}

export function buildOpenAiSpeechRequest(opts: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  voice: string;
  responseFormat: 'mp3' | 'wav';
  input: string;
}): { url: string; init: RequestInit } {
  const baseV1 = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  if (!baseV1) {
    throw new Error('Invalid base URL');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = (opts.apiKey ?? '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    url: `${baseV1}/audio/speech`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model,
        input: opts.input,
        voice: opts.voice,
        response_format: opts.responseFormat,
      }),
    },
  };
}

export type OpenAiCompatibleFile =
  | { kind: 'native'; uri: string; name: string; mimeType: string }
  | { kind: 'web'; blob: Blob; name: string };

export function buildOpenAiTranscriptionRequest(opts: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  language?: string | null;
  file: OpenAiCompatibleFile;
}): { url: string; init: RequestInit } {
  const baseV1 = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  if (!baseV1) {
    throw new Error('Invalid base URL');
  }
  const headers: Record<string, string> = {};
  const apiKey = (opts.apiKey ?? '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const form = new FormData();
  if (opts.file.kind === 'web') {
    form.append('file', opts.file.blob, opts.file.name);
  } else {
    form.append('file', { uri: opts.file.uri, name: opts.file.name, type: opts.file.mimeType } as any);
  }
  form.append('model', opts.model);
  if (opts.language) {
    form.append('language', opts.language);
  }

  return {
    url: `${baseV1}/audio/transcriptions`,
    init: {
      method: 'POST',
      headers,
      body: form,
    },
  };
}
