/** OpenAI Voice account operations with bounded response parsing. */
import {
  VoiceRealtimeJsonValueSchema,
  type VoiceClientAuthArtifact,
} from '@happier-dev/plugin-sdk/voice/client';
import {
  classifyVoiceProviderHttpFailure,
  type VoiceAccountOperationService,
} from '@happier-dev/plugin-sdk/voice';
import { z } from 'zod';

import { OpenAiRealtimeClientAuthProviderResponseSchema } from '../../protocol/voice/clientAuth.js';
import {
  OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL,
  OpenAiRealtimeSettingsV1Schema,
} from '../../protocol/voice/settings.js';

const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';
const MAX_RESPONSE_BYTES = 64 * 1024;
const AudienceSchema = z.object({
  model: z.string().trim().min(1).max(128),
  voice: z.string().trim().min(1).max(128),
  instructions: z.string().trim().max(10_000).nullable().optional(),
  turnDetection: z.enum(['server_vad', 'semantic_vad', 'manual']).optional(),
  inputTranscriptionModel: z.string().trim().max(128).nullable().optional(),
}).strict();

function providerError(
  code: 'invalid_parameters' | 'credential_unavailable' | 'provider_response_invalid',
): Error {
  return Object.assign(new Error(code), { code });
}

function readBoundedJsonBytes(body: Uint8Array): unknown {
  if (body.byteLength > MAX_RESPONSE_BYTES) throw providerError('provider_response_invalid');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw providerError('provider_response_invalid');
  }
}

function parseExpiryMs(value: unknown, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 10_000_000_000 ? Math.floor(value * 1_000) : Math.floor(value);
  return milliseconds > now + 1_000 && milliseconds <= now + 10 * 60_000 ? milliseconds : null;
}

function buildClientAuthRequest(audienceValue: string): Readonly<{
  body: string;
}> {
  let rawAudience: unknown;
  try { rawAudience = JSON.parse(audienceValue); } catch { throw providerError('invalid_parameters'); }
  const audience = AudienceSchema.safeParse(rawAudience);
  if (!audience.success) throw providerError('invalid_parameters');
  const settings = OpenAiRealtimeSettingsV1Schema.parse({
    model: { kind: 'pinned', id: audience.data.model },
    voice: audience.data.voice,
    instructions: audience.data.instructions ?? null,
    turnDetection: audience.data.turnDetection ?? 'server_vad',
    inputTranscriptionModel: audience.data.inputTranscriptionModel ?? null,
  });
  const audioInput: Record<string, unknown> = {
    turn_detection: settings.turnDetection === 'manual'
      ? null
      : {
          type: settings.turnDetection,
          // Happier owns the two-stage interruption decision. Provider VAD
          // still emits speech edges and creates turns, but cannot destroy
          // an in-flight answer before the backchannel/false-alarm gate, and
          // cannot answer a turn the gate has not released. Every response is
          // therefore created by the host once the committed turn is settled.
          create_response: false,
          interrupt_response: false,
        },
    // Without this block the provider never transcribes the user side and
    // every committed input item keeps `transcript: null`, leaving Happier
    // with no authoritative user content for the transcript or history.
    transcription: {
      model: settings.inputTranscriptionModel || OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL,
    },
  };
  const audio: Record<string, unknown> = {
    input: audioInput,
    output: { voice: settings.voice },
  };
  const session: Record<string, unknown> = {
    type: 'realtime',
    model: settings.model.id,
    audio,
    ...(settings.instructions ? { instructions: settings.instructions } : {}),
  };
  return Object.freeze({
    body: JSON.stringify({ session }),
  });
}

function parseClientAuthArtifact(
  value: unknown,
  now: number,
): VoiceClientAuthArtifact {
  const parsed = OpenAiRealtimeClientAuthProviderResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw providerError('provider_response_invalid');
  }
  const expiresAtMs = parseExpiryMs(parsed.data.expires_at, now);
  if (!expiresAtMs) {
    throw providerError('provider_response_invalid');
  }
  return Object.freeze({
    kind: 'bearer_token' as const,
    value: parsed.data.value,
    placement: 'authorization_header' as const,
    expiresAtMs,
  });
}

export function createOpenAiRealtimeCredentialOperations(input: Readonly<{
  apiBaseUrl?: string;
  now?: () => number;
}> = {}) {
  const baseUrl = (input.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, '');
  const now = input.now ?? Date.now;
  return Object.freeze({
    async mintClientAuthWithAccountOperations(params: Readonly<{
      accountOperations: VoiceAccountOperationService;
      audience: string;
      signal: AbortSignal;
    }>): Promise<VoiceClientAuthArtifact> {
      const request = buildClientAuthRequest(params.audience);
      if (baseUrl !== DEFAULT_API_BASE_URL) throw providerError('invalid_parameters');
      const response = await params.accountOperations.request({
        operationId: 'client-auth',
        parameters: Object.freeze({
          body: VoiceRealtimeJsonValueSchema.parse(JSON.parse(request.body)),
        }),
        signal: params.signal,
      });
      if (response.finalUrl !== `${baseUrl}/realtime/client_secrets`) {
        throw providerError('provider_response_invalid');
      }
      const httpFailure = classifyVoiceProviderHttpFailure(response.status);
      if (httpFailure) throw providerError(httpFailure);
      return parseClientAuthArtifact(readBoundedJsonBytes(response.body), now());
    },
    async fetchCatalog(): Promise<never> {
      throw Object.assign(new Error('operation_unsupported'), { code: 'operation_unsupported' });
    },
  });
}
