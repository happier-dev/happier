import {
  classifyVoiceProviderHttpFailure,
  type VoiceCredentialAccess,
} from '@happier-dev/plugin-sdk/voice';
import {
  containsProviderRegisteredSensitiveValue,
  ProviderEndpointUrlSyntaxSchema,
} from '@happier-dev/plugin-sdk/providers';
import type {
  SpeechProviderRuntime,
  VoiceSpeechOperationContext,
  VoiceSpeechSynthesizeRequest,
  VoiceSpeechTranscribeRequest,
} from '@happier-dev/plugin-sdk/voice/speech';

import {
  OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY,
  OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY,
} from '../speechIdentity.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_AUDIO_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;
const MAX_SYNTHESIS_CHARACTERS = 200_000;

type ProviderErrorCode =
  | 'invalid_parameters'
  | 'credential_unavailable'
  | 'provider_unavailable'
  | 'provider_response_invalid';

function providerError(code: ProviderErrorCode): Error {
  return Object.assign(new Error(code), { code });
}

function readSetting(settings: Readonly<Record<string, unknown>>, id: string, maximum: number): string | null {
  const value = settings[id];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function buildOperationUrl(settings: Readonly<Record<string, unknown>>, operationPath: string): string {
  const baseUrl = readSetting(settings, 'baseUrl', 2_048);
  if (!baseUrl) throw providerError('provider_unavailable');

  let parsed: URL;
  try {
    parsed = new URL(ProviderEndpointUrlSyntaxSchema.parse(baseUrl));
  } catch {
    throw providerError('provider_unavailable');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw providerError('provider_unavailable');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/${operationPath}`;
  return parsed.toString();
}

async function materializeBearerToken(
  credentials: VoiceCredentialAccess<'speech'>,
  environmentKey: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!credentials.raw) return null;
  const materialized = await credentials.raw.materialize({
    kind: 'environment',
    keys: [environmentKey],
  }, { signal });
  if (materialized.kind !== 'environment') throw providerError('credential_unavailable');
  const token = materialized.env[environmentKey]?.trim();
  if (!token || token.length > 16_384 || /[\r\n]/u.test(token)) {
    throw providerError('credential_unavailable');
  }
  return token;
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === expected)?.[1] ?? null;
}

function assertSuccessfulResponse(
  response: Readonly<{ status: number; finalUrl: string; body: Uint8Array }>,
  bearerToken: string | null,
): void {
  const failure = classifyVoiceProviderHttpFailure(response.status);
  if (failure) throw providerError(failure);
  if (bearerToken && containsProviderRegisteredSensitiveValue(response.finalUrl, [bearerToken])) {
    throw providerError('provider_response_invalid');
  }
}

function encodeMultipart(params: Readonly<{
  requestId: string;
  model: string;
  language: string | null;
  mimeType: VoiceSpeechTranscribeRequest['mimeType'];
  bytes: Uint8Array;
}>): Readonly<{ contentType: string; body: Uint8Array }> {
  const boundary = `happier-${params.requestId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 48)}-${globalThis.crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const appendText = (value: string) => chunks.push(encoder.encode(value));
  const appendField = (name: string, value: string) => {
    appendText(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  };
  appendField('model', params.model);
  if (params.language) appendField('language', params.language);
  const extension = params.mimeType === 'audio/wav'
    ? 'wav'
    : params.mimeType === 'audio/mpeg'
      ? 'mp3'
      : params.mimeType === 'audio/mp4'
        ? 'm4a'
        : 'webm';
  appendText(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${extension}"\r\nContent-Type: ${params.mimeType}\r\n\r\n`);
  chunks.push(params.bytes);
  appendText(`\r\n--${boundary}--\r\n`);

  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

function assertValidText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw providerError('provider_response_invalid');
  }
  return value;
}

function isSafeMultipartField(value: string): boolean {
  return !/[\r\n]/u.test(value);
}

async function transcribe(
  request: VoiceSpeechTranscribeRequest,
  context: VoiceSpeechOperationContext,
) {
  if (!request.bytes.byteLength || request.bytes.byteLength > MAX_AUDIO_INPUT_BYTES) {
    throw providerError('invalid_parameters');
  }
  const model = request.model.trim();
  const language = request.language?.trim() || null;
  if (
    !model
    || model.length > 256
    || !isSafeMultipartField(model)
    || (language?.length ?? 0) > 64
    || (language !== null && !isSafeMultipartField(language))
  ) {
    throw providerError('invalid_parameters');
  }
  const url = buildOperationUrl(context.settings, 'audio/transcriptions');
  const bearerToken = await materializeBearerToken(
    context.credentials,
    OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY,
    context.signal,
  );
  const multipart = encodeMultipart({
    requestId: request.requestId,
    model,
    language,
    mimeType: request.mimeType,
    bytes: request.bytes,
  });
  const response = await context.http.request({
    url,
    method: 'POST',
    headers: {
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      'content-type': multipart.contentType,
    },
    body: multipart.body,
    redirect: 'error',
    timeoutMs: REQUEST_TIMEOUT_MS,
  }, { signal: context.signal });
  assertSuccessfulResponse(response, bearerToken);
  const contentType = readHeader(response.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    throw providerError('provider_response_invalid');
  }
  const text = new TextDecoder().decode(response.body);
  if (bearerToken && containsProviderRegisteredSensitiveValue(text, [bearerToken])) {
    throw providerError('provider_response_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerError('provider_response_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw providerError('provider_response_invalid');
  }
  return {
    requestId: request.requestId,
    text: assertValidText((parsed as Readonly<{ text?: unknown }>).text, MAX_TRANSCRIPT_CHARACTERS),
  };
}

async function synthesize(
  request: VoiceSpeechSynthesizeRequest,
  context: VoiceSpeechOperationContext,
) {
  const model = request.model?.trim() ?? '';
  const voiceName = request.voiceName.trim();
  if (
    request.input.length === 0
    || request.input.length > MAX_SYNTHESIS_CHARACTERS
    || !model
    || model.length > 256
    || !voiceName
    || voiceName.length > 256
    || (request.speakingRate !== null && (!Number.isFinite(request.speakingRate) || request.speakingRate <= 0))
  ) {
    throw providerError('invalid_parameters');
  }
  const url = buildOperationUrl(context.settings, 'audio/speech');
  const bearerToken = await materializeBearerToken(
    context.credentials,
    OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY,
    context.signal,
  );
  const response = await context.http.request({
    url,
    method: 'POST',
    headers: {
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      'content-type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify({
      model,
      voice: voiceName,
      input: request.input,
      response_format: request.format,
      ...(request.speakingRate === null ? {} : { speed: request.speakingRate }),
    })),
    redirect: 'error',
    timeoutMs: REQUEST_TIMEOUT_MS,
  }, { signal: context.signal });
  assertSuccessfulResponse(response, bearerToken);
  const expectedMimeType = request.format === 'wav' ? 'audio/wav' as const : 'audio/mpeg' as const;
  const contentType = readHeader(response.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    contentType !== expectedMimeType
    || !response.body.byteLength
    || response.body.byteLength > MAX_AUDIO_OUTPUT_BYTES
    || (bearerToken && containsProviderRegisteredSensitiveValue(
      new TextDecoder().decode(response.body),
      [bearerToken],
    ))
  ) {
    throw providerError('provider_response_invalid');
  }
  return {
    requestId: request.requestId,
    bytes: new Uint8Array(response.body),
    mimeType: expectedMimeType,
  };
}

export function createOpenAiCompatSttRuntime(): SpeechProviderRuntime {
  return Object.freeze({
    kind: 'speech' as const,
    async transcribe(request, context) {
      return await transcribe(request, context);
    },
  });
}

export function createOpenAiCompatTtsRuntime(): SpeechProviderRuntime {
  return Object.freeze({
    kind: 'speech' as const,
    async synthesize(request, context) {
      return await synthesize(request, context);
    },
  });
}

export const OPENAI_COMPAT_STT_RUNTIME: SpeechProviderRuntime = createOpenAiCompatSttRuntime();
export const OPENAI_COMPAT_TTS_RUNTIME: SpeechProviderRuntime = createOpenAiCompatTtsRuntime();
