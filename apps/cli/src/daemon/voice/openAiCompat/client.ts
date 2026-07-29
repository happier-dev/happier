import { lookup } from 'node:dns/promises';

import { z } from 'zod';
import {
  DAEMON_VOICE_OPENAI_COMPAT_RESPONSE_MAX_BYTES,
  DaemonVoiceOpenAiCompatChatRequestSchema,
  DaemonVoiceOpenAiCompatChatResponseSchema,
  DaemonVoiceOpenAiCompatModelsListRequestSchema,
  DaemonVoiceOpenAiCompatModelsListResponseSchema,
  DaemonVoiceOpenAiCompatSynthesizeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeResponseSchema,
  ProviderEndpointSafetyError,
  assessProviderEndpoint,
  containsProviderRegisteredSensitiveValue,
  normalizeProviderEndpointUrlSyntax,
  type AssessedProviderEndpoint,
  type DaemonVoiceOpenAiCompatChatRequest,
  type DaemonVoiceOpenAiCompatChatResponse,
  type DaemonVoiceOpenAiCompatError,
  type DaemonVoiceOpenAiCompatErrorCode,
  type DaemonVoiceOpenAiCompatModelsListRequest,
  type DaemonVoiceOpenAiCompatModelsListResponse,
  type DaemonVoiceOpenAiCompatTranscribeResponse,
} from '@happier-dev/protocol';

import type { VoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import { fetchPinnedProviderEndpoint } from './network';

const DEFAULT_TIMEOUT_MS = 30_000;
const JSON_CONTENT_TYPE_PATTERN = /^(?:application\/json|[^;]+\+json)(?:;|$)/iu;
type VoiceHttpHeadersInit = ConstructorParameters<typeof Headers>[0];

const ModelsWireResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1).max(256) }).passthrough()).max(2_000),
}).passthrough();
const ChatWireResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().max(1_000_000) }).passthrough(),
  }).passthrough()).min(1).max(128),
}).passthrough();
const TranscriptionWireResponseSchema = z.object({ text: z.string().max(1_000_000) }).passthrough();
const InternalTranscribeRequestSchema = DaemonVoiceOpenAiCompatTranscribeRequestSchema
  .omit({ uploadId: true })
  .extend({
    audio: z.object({
      bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024),
      mimeType: z.enum(['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg']),
      fileName: z.string().trim().min(1).max(256).regex(/^[^/\\\u0000-\u001f\u007f]+$/u),
    }).strict(),
  })
  .strict();
const InternalSynthesizeRequestSchema = DaemonVoiceOpenAiCompatSynthesizeRequestSchema
  .omit({ recipientPublicKeyBase64: true })
  .strict();

export type OpenAiCompatVoiceTranscribeRequest = z.infer<typeof InternalTranscribeRequestSchema>;
export type OpenAiCompatVoiceSynthesizeRequest = z.infer<typeof InternalSynthesizeRequestSchema>;
export type OpenAiCompatVoiceSynthesizeResponse =
  | Readonly<{ ok: true; bytes: Uint8Array; mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/ogg' | 'audio/aac' | 'audio/flac' | 'audio/l16' | 'application/octet-stream' }>
  | DaemonVoiceOpenAiCompatError;

class OpenAiCompatClientError extends Error {
  readonly code: DaemonVoiceOpenAiCompatErrorCode;
  readonly retryable: boolean;

  constructor(code: DaemonVoiceOpenAiCompatErrorCode, retryable = false) {
    super(code);
    this.name = 'OpenAiCompatClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

function safeError(code: DaemonVoiceOpenAiCompatErrorCode, retryable = false): DaemonVoiceOpenAiCompatError {
  return Object.freeze({ ok: false, errorCode: code, error: code, retryable });
}

function classifyError(error: unknown, timedOut: boolean): DaemonVoiceOpenAiCompatError {
  if (timedOut) return safeError('request_timeout', true);
  if (error instanceof OpenAiCompatClientError) return safeError(error.code, error.retryable);
  if (error instanceof ProviderEndpointSafetyError) {
    return safeError(
      ['http_public_forbidden', 'unsafe_address', 'odd_ip_encoding'].includes(error.code)
        ? 'endpoint_unsafe'
        : 'endpoint_invalid',
    );
  }
  if ((error as { code?: unknown } | null)?.code === 'credential_unavailable') {
    return safeError('credential_unavailable');
  }
  if ((error as { name?: unknown } | null)?.name === 'AbortError') return safeError('cancelled');
  return safeError('internal_error');
}

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function buildOperationUrl(endpoint: AssessedProviderEndpoint, suffix: string): string {
  const url = new URL(endpoint.normalizedUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${suffix.replace(/^\/+/, '')}`;
  url.hash = '';
  return url.toString();
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > DAEMON_VOICE_OPENAI_COMPAT_RESPONSE_MAX_BYTES) {
      throw new OpenAiCompatClientError('response_too_large');
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > DAEMON_VOICE_OPENAI_COMPAT_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OpenAiCompatClientError('response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requireJson(response: Response): void {
  if (!JSON_CONTENT_TYPE_PATTERN.test(response.headers.get('content-type') ?? '')) {
    throw new OpenAiCompatClientError('unsupported_media_type');
  }
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new OpenAiCompatClientError('provider_response_invalid');
  }
}

export type OpenAiCompatVoiceClient = Readonly<{
  chat(request: DaemonVoiceOpenAiCompatChatRequest): Promise<DaemonVoiceOpenAiCompatChatResponse>;
  modelsList(request: DaemonVoiceOpenAiCompatModelsListRequest): Promise<DaemonVoiceOpenAiCompatModelsListResponse>;
  transcribe(request: OpenAiCompatVoiceTranscribeRequest): Promise<DaemonVoiceOpenAiCompatTranscribeResponse>;
  synthesize(request: OpenAiCompatVoiceSynthesizeRequest): Promise<OpenAiCompatVoiceSynthesizeResponse>;
  cancel(requestId: string): boolean;
}>;

export function createOpenAiCompatVoiceClient(params: Readonly<{
  credentialResolver: VoiceCredentialResolver;
  fetch?: typeof fetch;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
}>): OpenAiCompatVoiceClient {
  const fetchBoundary = params.fetch ?? globalThis.fetch;
  const resolveAddresses = params.resolveAddresses ?? defaultResolveAddresses;
  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const activeRequests = new Map<string, AbortController>();

  async function assess(baseUrl: string, consent: string | null): Promise<AssessedProviderEndpoint> {
    const syntax = normalizeProviderEndpointUrlSyntax(baseUrl);
    const resolvedAddresses = syntax.literalAddress ? undefined : await resolveAddresses(syntax.hostname);
    const endpoint = assessProviderEndpoint(syntax.normalizedUrl, {
      ...(resolvedAddresses ? { resolvedAddresses } : {}),
      privateNetworkConfirmed: consent === syntax.origin,
    });
    if (endpoint.protocol === 'http:' && endpoint.locality !== 'public' && consent !== endpoint.origin) {
      throw new OpenAiCompatClientError('endpoint_consent_required');
    }
    return endpoint;
  }

  async function execute<T>(input: Readonly<{
    requestId?: string;
    baseUrl: string;
    insecureLocalOriginConsent: string | null;
    credentialKind: string;
    suffix: string;
    init: Omit<RequestInit, 'headers' | 'signal' | 'redirect'> & Readonly<{ headers?: VoiceHttpHeadersInit }>;
    parse: (response: Response, body: Uint8Array) => T;
  }>): Promise<T | DaemonVoiceOpenAiCompatError> {
    let timedOut = false;
    const controller = new AbortController();
    if (input.requestId) {
      if (activeRequests.has(input.requestId)) return safeError('invalid_parameters');
      activeRequests.set(input.requestId, controller);
    }
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new OpenAiCompatClientError('request_timeout', true));
      }, timeoutMs);
    });
    try {
      const operation = (async () => {
        const endpoint = await assess(input.baseUrl, input.insecureLocalOriginConsent);
        if (controller.signal.aborted) {
          throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
        }
        const requestProvider = async (secret: string | null): Promise<T> => {
            if (controller.signal.aborted) {
              throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
            }
            const headers = new Headers(input.init.headers);
            if (secret !== null) headers.set('authorization', `Bearer ${secret}`);
            const requestUrl = buildOperationUrl(endpoint, input.suffix);
            const requestInit: RequestInit = {
              ...input.init,
              headers,
              signal: controller.signal,
              redirect: 'manual',
            };
            const fetched = params.fetch
              ? { response: await fetchBoundary(requestUrl, requestInit), dispose: async () => undefined }
              : await fetchPinnedProviderEndpoint({ endpoint, url: requestUrl, init: requestInit });
            try {
              const { response } = fetched;
              if (response.status >= 300 && response.status < 400) {
                throw new OpenAiCompatClientError('redirect_forbidden');
              }
              if (!response.ok) {
                if (secret === null && (response.status === 401 || response.status === 403)) {
                  throw new OpenAiCompatClientError('credential_unavailable');
                }
                throw new OpenAiCompatClientError(
                  'provider_error',
                  response.status >= 500 || response.status === 429,
                );
              }
              const body = await readBoundedBody(response);
              if (
                secret !== null
                && containsProviderRegisteredSensitiveValue(new TextDecoder().decode(body), [secret])
              ) {
                throw new OpenAiCompatClientError('provider_response_invalid');
              }
              return input.parse(response, body);
            } finally {
              await fetched.dispose();
            }
        };
        const credentialAvailability = params.credentialResolver.status('openai_compat', input.credentialKind);
        if (!credentialAvailability.available) return await requestProvider(null);
        return await params.credentialResolver.withSecret({
          providerId: 'openai_compat',
          credentialSlotId: input.credentialKind,
          use: requestProvider,
        });
      })();
      return await Promise.race([operation, timeout]);
    } catch (error) {
      return classifyError(error, timedOut);
    } finally {
      clearTimeout(timer!);
      if (input.requestId && activeRequests.get(input.requestId) === controller) {
        activeRequests.delete(input.requestId);
      }
    }
  }

  return Object.freeze({
    async modelsList(raw) {
      const parsed = DaemonVoiceOpenAiCompatModelsListRequestSchema.safeParse(raw);
      if (!parsed.success) return safeError('invalid_parameters');
      const result = await execute({
        ...parsed.data,
        suffix: 'models',
        init: { method: 'GET' },
        parse: (response, body) => {
          requireJson(response);
          const wire = ModelsWireResponseSchema.safeParse(parseJsonBytes(body));
          if (!wire.success) throw new OpenAiCompatClientError('provider_response_invalid');
          return DaemonVoiceOpenAiCompatModelsListResponseSchema.parse({
            ok: true,
            models: wire.data.data.map(({ id }) => ({ id })),
          });
        },
      });
      return DaemonVoiceOpenAiCompatModelsListResponseSchema.parse(result);
    },
    async chat(raw) {
      const parsed = DaemonVoiceOpenAiCompatChatRequestSchema.safeParse(raw);
      if (!parsed.success) return safeError('invalid_parameters');
      const result = await execute({
        ...parsed.data,
        suffix: 'chat/completions',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: parsed.data.model,
            messages: parsed.data.messages,
            ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
            ...(parsed.data.maxTokens !== undefined ? { max_tokens: parsed.data.maxTokens } : {}),
          }),
        },
        parse: (response, body) => {
          requireJson(response);
          const wire = ChatWireResponseSchema.safeParse(parseJsonBytes(body));
          if (!wire.success) throw new OpenAiCompatClientError('provider_response_invalid');
          return DaemonVoiceOpenAiCompatChatResponseSchema.parse({ ok: true, text: wire.data.choices[0]!.message.content });
        },
      });
      return DaemonVoiceOpenAiCompatChatResponseSchema.parse(result);
    },
    async transcribe(raw) {
      const parsed = InternalTranscribeRequestSchema.safeParse(raw);
      if (!parsed.success) return safeError('invalid_parameters');
      const form = new FormData();
      form.set('model', parsed.data.model);
      if (parsed.data.language) form.set('language', parsed.data.language);
      if (parsed.data.prompt) form.set('prompt', parsed.data.prompt);
      form.set('file', new Blob([parsed.data.audio.bytes], { type: parsed.data.audio.mimeType }), parsed.data.audio.fileName);
      const result = await execute({
        ...parsed.data,
        suffix: 'audio/transcriptions',
        init: { method: 'POST', body: form },
        parse: (response, body) => {
          requireJson(response);
          const wire = TranscriptionWireResponseSchema.safeParse(parseJsonBytes(body));
          if (!wire.success) throw new OpenAiCompatClientError('provider_response_invalid');
          return DaemonVoiceOpenAiCompatTranscribeResponseSchema.parse({ ok: true, text: wire.data.text });
        },
      });
      return DaemonVoiceOpenAiCompatTranscribeResponseSchema.parse(result);
    },
    async synthesize(raw) {
      const parsed = InternalSynthesizeRequestSchema.safeParse(raw);
      if (!parsed.success) return safeError('invalid_parameters');
      const result = await execute({
        ...parsed.data,
        suffix: 'audio/speech',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: parsed.data.model,
            voice: parsed.data.voice,
            input: parsed.data.text,
            response_format: parsed.data.responseFormat,
            ...(parsed.data.speed !== undefined ? { speed: parsed.data.speed } : {}),
          }),
        },
        parse: (response, body) => {
          const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
          const allowedMimeTypesByFormat: Readonly<Record<typeof parsed.data.responseFormat, ReadonlySet<string>>> = {
            wav: new Set(['audio/wav']),
            mp3: new Set(['audio/mpeg']),
            opus: new Set(['audio/ogg']),
            aac: new Set(['audio/aac']),
            flac: new Set(['audio/flac']),
            pcm: new Set(['audio/l16', 'application/octet-stream']),
          };
          const allowedMimeTypes = allowedMimeTypesByFormat[parsed.data.responseFormat];
          if (!allowedMimeTypes.has(mimeType)) throw new OpenAiCompatClientError('unsupported_media_type');
          if (body.byteLength === 0) throw new OpenAiCompatClientError('provider_response_invalid');
          return Object.freeze({
            ok: true,
            bytes: body,
            mimeType,
          });
        },
      });
      return result as OpenAiCompatVoiceSynthesizeResponse;
    },
    cancel(requestId) {
      const controller = activeRequests.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  });
}
