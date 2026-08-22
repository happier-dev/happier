import {
  classifyVoiceProviderHttpFailure,
  type VoiceCredentialAccess,
} from '@happier-dev/plugin-sdk/voice';
import { containsProviderRegisteredSensitiveValue } from '@happier-dev/plugin-sdk/providers';
import type {
  SpeechProviderRuntime,
  VoiceProviderCatalogItem,
  VoiceSpeechOperationContext,
  VoiceSpeechSynthesizeRequest,
  VoiceSpeechTranscribeRequest,
} from '@happier-dev/plugin-sdk/voice/speech';

import {
  GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION,
  GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION,
} from './declarations.js';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const GOOGLE_GEMINI_INLINE_REQUEST_MAX_BYTES = 20_000_000;
const GOOGLE_CLOUD_TTS_MAX_INPUT_UTF8_BYTES = 5_000;
const GOOGLE_GEMINI_STT_LIMITS = GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION.limits.transcribe;
const GOOGLE_CLOUD_TTS_LIMITS = GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION.limits.synthesize;
if (!GOOGLE_GEMINI_STT_LIMITS || !GOOGLE_CLOUD_TTS_LIMITS) {
  throw new Error('Google Voice manifest is missing executable speech limits');
}
// The daemon upload protocol is the end-to-end admission ceiling.
export const GOOGLE_GEMINI_STT_MAX_INPUT_BYTES =
  GOOGLE_GEMINI_STT_LIMITS.maxInputBytes;
// Manifest character limits use JavaScript string units; 1,666 units encode to at most 4,998 UTF-8 bytes.
export const GOOGLE_CLOUD_TTS_MAX_INPUT_CHARACTERS =
  GOOGLE_CLOUD_TTS_LIMITS.maxInputCharacters;
export const GOOGLE_CLOUD_TTS_MAX_OUTPUT_BYTES =
  GOOGLE_CLOUD_TTS_LIMITS.maxOutputBytes;
const GOOGLE_API_KEY_HEADER = 'x-goog-api-key';
const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
const GOOGLE_CLOUD_TTS_ORIGIN = 'https://texttospeech.googleapis.com';

function providerError(
  code: 'invalid_parameters' | 'credential_unavailable' | 'provider_response_invalid',
): Error {
  return Object.assign(new Error(code), { code });
}

async function materializeApiKey(
  credentials: VoiceCredentialAccess<'speech'>,
  origin: string,
  signal: AbortSignal,
): Promise<string> {
  if (!credentials.raw) throw providerError('credential_unavailable');
  const materialized = await credentials.raw.materialize({
    kind: 'httpHeaders',
    origin,
    headerNames: [GOOGLE_API_KEY_HEADER],
  }, { signal });
  if (materialized.kind !== 'httpHeaders') throw providerError('credential_unavailable');
  const entry = Object.entries(materialized.headers).find(
    ([name]) => name.toLowerCase() === GOOGLE_API_KEY_HEADER,
  );
  const apiKey = entry?.[1].trim();
  if (!apiKey || apiKey.length > 16_384) throw providerError('credential_unavailable');
  return apiKey;
}

type HttpResponse = Awaited<ReturnType<VoiceSpeechOperationContext['http']['request']>>;

function readResponseHeader(
  headers: Readonly<Record<string, string>>,
  expectedName: string,
): string | null {
  const expected = expectedName.toLowerCase();
  return Object.entries(headers).find(([name]) => name.toLowerCase() === expected)?.[1] ?? null;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base64EncodedLength(value: number): number {
  return 4 * Math.ceil(value / 3);
}

function readJson(response: HttpResponse, registeredSensitiveValues: readonly string[]): unknown {
  const httpFailure = classifyVoiceProviderHttpFailure(response.status);
  if (httpFailure) throw providerError(httpFailure);
  const declaredHeader = readResponseHeader(response.headers, 'content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_JSON_BYTES) {
      throw providerError('provider_response_invalid');
    }
  }
  if (response.body.byteLength > MAX_JSON_BYTES) throw providerError('provider_response_invalid');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw providerError('provider_response_invalid');
  }
  if (containsProviderRegisteredSensitiveValue(text, registeredSensitiveValues)) {
    throw providerError('provider_response_invalid');
  }
  try { return JSON.parse(text); } catch { throw providerError('provider_response_invalid'); }
}

function clean(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max ? result : null;
}

function joinBounded(values: readonly string[], maximum: number): string {
  const accepted: string[] = [];
  let length = 0;
  for (const value of values) {
    const nextLength = length + (accepted.length === 0 ? 0 : 1) + value.length;
    if (nextLength > maximum) break;
    accepted.push(value);
    length = nextLength;
  }
  return accepted.join(',');
}

/**
 * The catalog rows as the provider returned them.
 *
 * A missing or non-array field is an unreadable payload, not an account that
 * owns nothing: normalizing it to `[]` reports "no models/voices available" for
 * a malformed provider response and hides the real failure. A genuinely empty
 * array stays a legitimate empty catalog.
 */
function readCatalogEntries(value: unknown, field: 'models' | 'voices'): readonly unknown[] {
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[field]
    : undefined;
  if (!Array.isArray(entries)) throw providerError('provider_response_invalid');
  return entries;
}

function parseGeminiModels(value: unknown): readonly VoiceProviderCatalogItem[] {
  const models = readCatalogEntries(value, 'models');
  const rows = models.slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const name = clean(record.name, 256);
    const supported = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods : [];
    if (!name || !supported.includes('generateContent')) return [];
    const id = clean(name.startsWith('models/') ? name.slice('models/'.length) : name, 256);
    if (!id) return [];
    return [{ id, name: clean(record.displayName, 256) ?? id, metadata: { description: clean(record.description) ?? '' } }];
  });
  const unique = new Map<string, VoiceProviderCatalogItem>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function parseGoogleVoices(value: unknown): readonly VoiceProviderCatalogItem[] {
  const voices = readCatalogEntries(value, 'voices');
  const rows = voices.slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const id = clean(record.name, 256);
    if (!id) return [];
    const languageCodes = Array.isArray(record.languageCodes)
      ? joinBounded([...new Set(record.languageCodes.map((entry) => clean(entry, 64)).filter((entry): entry is string => Boolean(entry)))], 512)
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
  const unique = new Map<string, VoiceProviderCatalogItem>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function transcribe(
  request: VoiceSpeechTranscribeRequest,
  context: VoiceSpeechOperationContext,
) {
  if (!request.bytes.byteLength || request.bytes.byteLength > GOOGLE_GEMINI_STT_MAX_INPUT_BYTES) {
    throw providerError('invalid_parameters');
  }
  const instruction = request.language
    ? `Transcribe this audio. Language: ${request.language}. Return only the transcript text.`
    : 'Transcribe this audio. Return only the transcript text.';
  const body = encodeJson({ contents: [{ role: 'user', parts: [
    { text: instruction },
    { inline_data: { mime_type: request.mimeType, data: Buffer.from(request.bytes).toString('base64') } },
  ] }] });
  if (body.byteLength > GOOGLE_GEMINI_INLINE_REQUEST_MAX_BYTES) {
    throw providerError('invalid_parameters');
  }
  const secret = await materializeApiKey(context.credentials, GEMINI_ORIGIN, context.signal);
  const response = await context.http.request(
    {
      url: `${GEMINI_ORIGIN}/v1beta/models/${encodeURIComponent(request.model.replace(/^models\//u, ''))}:generateContent`,
      method: 'POST',
      headers: { 'content-type': 'application/json', [GOOGLE_API_KEY_HEADER]: secret },
      redirect: 'error',
      body,
    },
    { signal: context.signal },
  );
  const json = readJson(response, [secret]) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  const text = clean(json.candidates?.[0]?.content?.parts?.find((part) => clean(part.text, 20_000))?.text, 20_000);
  if (!text) throw providerError('provider_response_invalid');
  return { requestId: request.requestId, text };
}

async function synthesize(
  request: VoiceSpeechSynthesizeRequest,
  context: VoiceSpeechOperationContext,
) {
  if (!request.input.length || utf8ByteLength(request.input) > GOOGLE_CLOUD_TTS_MAX_INPUT_UTF8_BYTES) {
    throw providerError('invalid_parameters');
  }
  const secret = await materializeApiKey(context.credentials, GOOGLE_CLOUD_TTS_ORIGIN, context.signal);
  const response = await context.http.request({
    url: `${GOOGLE_CLOUD_TTS_ORIGIN}/v1/text:synthesize`,
    method: 'POST',
    headers: { 'content-type': 'application/json', [GOOGLE_API_KEY_HEADER]: secret },
    redirect: 'error',
    body: encodeJson({
      input: { text: request.input },
      voice: { name: request.voiceName, ...(request.languageCode ? { languageCode: request.languageCode } : {}) },
      audioConfig: {
        audioEncoding: request.format === 'wav' ? 'LINEAR16' : 'MP3',
        ...(request.speakingRate == null ? {} : { speakingRate: request.speakingRate }),
        ...(request.pitch == null ? {} : { pitch: request.pitch }),
      },
    }),
  }, { signal: context.signal });
  const json = readJson(response, [secret]) as { audioContent?: unknown };
  const encoded = clean(json.audioContent, base64EncodedLength(GOOGLE_CLOUD_TTS_MAX_OUTPUT_BYTES));
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw providerError('provider_response_invalid');
  }
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (!bytes.byteLength || bytes.byteLength > GOOGLE_CLOUD_TTS_MAX_OUTPUT_BYTES) throw providerError('provider_response_invalid');
  return { requestId: request.requestId, bytes, mimeType: request.format === 'wav' ? 'audio/wav' as const : 'audio/mpeg' as const };
}

export function createGoogleGeminiSttRuntime(): SpeechProviderRuntime {
  return Object.freeze({
    kind: 'speech' as const,
    catalog: Object.freeze({
      async list(
        request: Readonly<{ catalog: 'voices' | 'models' }>,
        context: VoiceSpeechOperationContext,
      ) {
        if (request.catalog !== 'models') throw providerError('invalid_parameters');
        const secret = await materializeApiKey(context.credentials, GEMINI_ORIGIN, context.signal);
        return parseGeminiModels(readJson(await context.http.request({
          url: `${GEMINI_ORIGIN}/v1beta/models`,
          method: 'GET',
          headers: { [GOOGLE_API_KEY_HEADER]: secret },
          redirect: 'error',
        }, { signal: context.signal }), [secret]));
      },
    }),
    async transcribe(request: VoiceSpeechTranscribeRequest, context: VoiceSpeechOperationContext) {
      return await transcribe(request, context);
    },
  });
}

export function createGoogleCloudTtsRuntime(): SpeechProviderRuntime {
  return Object.freeze({
    kind: 'speech' as const,
    catalog: Object.freeze({
      async list(
        request: Readonly<{ catalog: 'voices' | 'models' }>,
        context: VoiceSpeechOperationContext,
      ) {
        if (request.catalog !== 'voices') throw providerError('invalid_parameters');
        const secret = await materializeApiKey(context.credentials, GOOGLE_CLOUD_TTS_ORIGIN, context.signal);
        return parseGoogleVoices(readJson(await context.http.request({
          url: `${GOOGLE_CLOUD_TTS_ORIGIN}/v1/voices`,
          method: 'GET',
          headers: { [GOOGLE_API_KEY_HEADER]: secret },
          redirect: 'error',
        }, { signal: context.signal }), [secret]));
      },
    }),
    async synthesize(request: VoiceSpeechSynthesizeRequest, context: VoiceSpeechOperationContext) {
      return await synthesize(request, context);
    },
  });
}

export const GOOGLE_GEMINI_STT_RUNTIME: SpeechProviderRuntime = createGoogleGeminiSttRuntime();
export const GOOGLE_CLOUD_TTS_RUNTIME: SpeechProviderRuntime = createGoogleCloudTtsRuntime();
