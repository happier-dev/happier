import type { DaemonVoiceProviderCatalogItem } from '@happier-dev/protocol';

import {
  GoogleCloudSynthesizeRequestSchema,
  GoogleCloudSynthesizeResponseSchema,
  GoogleGeminiTranscribeRequestSchema,
  GoogleGeminiTranscribeResponseSchema,
  GOOGLE_CLOUD_TTS_PROVIDER_ID,
  GOOGLE_GEMINI_STT_PROVIDER_ID,
  type GoogleCloudSynthesizeRequest,
} from '../../protocol/voice/index.js';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

type Fetch = typeof globalThis.fetch;

export type GoogleGeminiAgentTranscribeRequest = Readonly<{
  requestId: string;
  model: string;
  language: string | null;
  mimeType: string;
  bytes: Uint8Array;
}>;

export type GoogleVoiceAgentOperations = Readonly<{
  transcribe(params: Readonly<{ secret: string; request: GoogleGeminiAgentTranscribeRequest; signal: AbortSignal }>): Promise<Readonly<{ requestId: string; text: string }>>;
  synthesize(params: Readonly<{ secret: string; request: GoogleCloudSynthesizeRequest; signal: AbortSignal }>): Promise<Readonly<{ requestId: string; bytes: Uint8Array; mimeType: 'audio/mpeg' | 'audio/wav' }>>;
}>;

export type GoogleVoiceAgentEntry = Readonly<{
  kind: 'voice.agent.v1';
  pluginId: 'happier.voice.google';
  credentialProviders: readonly Readonly<{
    providerId: 'google_gemini' | 'google_cloud';
    credentialOperations: Readonly<{
      fetchCatalog(params: Readonly<{ secret: string; catalog: 'voices' | 'models'; signal: AbortSignal }>): Promise<readonly DaemonVoiceProviderCatalogItem[]>;
    }>;
  }>[];
  operations: GoogleVoiceAgentOperations;
  speechProviderIds: Readonly<{
    transcribe: 'google_gemini';
    synthesize: 'google_cloud';
  }>;
  schemas: Readonly<{
    transcribeRequest: typeof GoogleGeminiTranscribeRequestSchema;
    transcribeResponse: typeof GoogleGeminiTranscribeResponseSchema;
    synthesizeRequest: typeof GoogleCloudSynthesizeRequestSchema;
    synthesizeResponse: typeof GoogleCloudSynthesizeResponseSchema;
  }>;
}>;

function providerError(code: 'invalid_parameters' | 'provider_response_invalid'): Error {
  return Object.assign(new Error(code), { code });
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw providerError('provider_response_invalid');
  }
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_JSON_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw providerError('provider_response_invalid');
    }
  }
  if (!response.body) throw providerError('provider_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw providerError('provider_response_invalid');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try { return JSON.parse(text); } catch { throw providerError('provider_response_invalid'); }
}

function clean(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max ? result : null;
}

function parseGeminiModels(value: unknown): readonly DaemonVoiceProviderCatalogItem[] {
  const models = value && typeof value === 'object' && Array.isArray((value as { models?: unknown }).models)
    ? (value as { models: unknown[] }).models
    : [];
  const rows = models.slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const name = clean(record.name, 256);
    const supported = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods : [];
    if (!name || !supported.includes('generateContent')) return [];
    const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
    return [{ id, name: clean(record.displayName, 256) ?? id, metadata: { description: clean(record.description) ?? '' } }];
  });
  const unique = new Map<string, DaemonVoiceProviderCatalogItem>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function parseGoogleVoices(value: unknown): readonly DaemonVoiceProviderCatalogItem[] {
  const voices = value && typeof value === 'object' && Array.isArray((value as { voices?: unknown }).voices)
    ? (value as { voices: unknown[] }).voices
    : [];
  const rows = voices.slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const id = clean(record.name, 256);
    if (!id) return [];
    const languageCodes = Array.isArray(record.languageCodes)
      ? [...new Set(record.languageCodes.map((entry) => clean(entry, 64)).filter((entry): entry is string => Boolean(entry)))].join(',')
      : '';
    const naturalSampleRateHertz = typeof record.naturalSampleRateHertz === 'number'
      && Number.isInteger(record.naturalSampleRateHertz)
      && record.naturalSampleRateHertz > 0
      && record.naturalSampleRateHertz <= 384_000
      ? record.naturalSampleRateHertz
      : null;
    return [{
      id,
      name: id,
      metadata: {
        languageCodes,
        ssmlGender: clean(record.ssmlGender, 64) ?? '',
        ...(naturalSampleRateHertz === null ? {} : { naturalSampleRateHertz }),
      },
    }];
  });
  const unique = new Map<string, DaemonVoiceProviderCatalogItem>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function createGoogleVoiceAgentOperations(params?: Readonly<{ fetch?: Fetch }>): GoogleVoiceAgentOperations {
  const fetchImpl = params?.fetch ?? globalThis.fetch;
  return Object.freeze({
    async transcribe({ secret, request, signal }) {
      if (!request.bytes.byteLength || request.bytes.byteLength > MAX_AUDIO_BYTES) throw providerError('invalid_parameters');
      const instruction = request.language
        ? `Transcribe this audio. Language: ${request.language}. Return only the transcript text.`
        : 'Transcribe this audio. Return only the transcript text.';
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model.replace(/^models\//u, ''))}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': secret },
          redirect: 'error',
          signal,
          body: JSON.stringify({ contents: [{ role: 'user', parts: [
            { text: instruction },
            { inline_data: { mime_type: request.mimeType, data: Buffer.from(request.bytes).toString('base64') } },
          ] }] }),
        },
      );
      const json = await readJson(response) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
      const text = clean(json.candidates?.[0]?.content?.parts?.find((part) => clean(part.text, 20_000))?.text, 20_000);
      if (!text) throw providerError('provider_response_invalid');
      return { requestId: request.requestId, text };
    },
    async synthesize({ secret, request, signal }) {
      const response = await fetchImpl('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': secret },
        redirect: 'error',
        signal,
        body: JSON.stringify({
          input: { text: request.input },
          voice: { name: request.voiceName, ...(request.languageCode ? { languageCode: request.languageCode } : {}) },
          audioConfig: {
            audioEncoding: request.format === 'wav' ? 'LINEAR16' : 'MP3',
            ...(request.speakingRate == null ? {} : { speakingRate: request.speakingRate }),
            ...(request.pitch == null ? {} : { pitch: request.pitch }),
          },
        }),
      });
      const json = await readJson(response) as { audioContent?: unknown };
      const encoded = clean(json.audioContent, Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 8);
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
        throw providerError('provider_response_invalid');
      }
      const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
      if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) throw providerError('provider_response_invalid');
      return { requestId: request.requestId, bytes, mimeType: request.format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
    },
  });
}

function createCatalogOperations(providerId: 'google_gemini' | 'google_cloud', fetchImpl: Fetch) {
  return Object.freeze({
    async fetchCatalog(params: Readonly<{ secret: string; catalog: 'voices' | 'models'; signal: AbortSignal }>) {
      if (providerId === GOOGLE_GEMINI_STT_PROVIDER_ID && params.catalog === 'models') {
        return parseGeminiModels(await readJson(await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', {
          method: 'GET', headers: { 'x-goog-api-key': params.secret }, redirect: 'error', signal: params.signal,
        })));
      }
      if (providerId === GOOGLE_CLOUD_TTS_PROVIDER_ID && params.catalog === 'voices') {
        return parseGoogleVoices(await readJson(await fetchImpl('https://texttospeech.googleapis.com/v1/voices', {
          method: 'GET', headers: { 'x-goog-api-key': params.secret }, redirect: 'error', signal: params.signal,
        })));
      }
      throw providerError('invalid_parameters');
    },
  });
}

export function createGoogleVoiceAgentEntry(params?: Readonly<{ fetch?: Fetch }>): GoogleVoiceAgentEntry {
  const fetchImpl = params?.fetch ?? globalThis.fetch;
  return Object.freeze({
    kind: 'voice.agent.v1',
    pluginId: 'happier.voice.google',
    credentialProviders: Object.freeze([
      Object.freeze({ providerId: GOOGLE_GEMINI_STT_PROVIDER_ID, credentialOperations: createCatalogOperations(GOOGLE_GEMINI_STT_PROVIDER_ID, fetchImpl) }),
      Object.freeze({ providerId: GOOGLE_CLOUD_TTS_PROVIDER_ID, credentialOperations: createCatalogOperations(GOOGLE_CLOUD_TTS_PROVIDER_ID, fetchImpl) }),
    ]),
    operations: createGoogleVoiceAgentOperations({ fetch: fetchImpl }),
    speechProviderIds: Object.freeze({
      transcribe: GOOGLE_GEMINI_STT_PROVIDER_ID,
      synthesize: GOOGLE_CLOUD_TTS_PROVIDER_ID,
    }),
    schemas: Object.freeze({
      transcribeRequest: GoogleGeminiTranscribeRequestSchema,
      transcribeResponse: GoogleGeminiTranscribeResponseSchema,
      synthesizeRequest: GoogleCloudSynthesizeRequestSchema,
      synthesizeResponse: GoogleCloudSynthesizeResponseSchema,
    }),
  });
}

export const GOOGLE_VOICE_AGENT_ENTRY = createGoogleVoiceAgentEntry();
