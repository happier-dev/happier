/** Private built-in Voice operations; never projected through the public plugin ABI. */
import {
  type VoiceClientAuthArtifact,
} from '@happier-dev/plugin-sdk/voice/client';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import {
  classifyVoiceProviderHttpFailure,
  type VoiceAccountOperationService,
} from '@happier-dev/plugin-sdk/voice';
import type { VoiceProviderCatalogItem } from '@happier-dev/plugin-sdk/voice/speech';
import { z } from 'zod';

const DEFAULT_API_BASE_URL = 'https://api.x.ai/v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const AudienceSchema = z.object({ platform: z.enum(['web', 'native']) }).strict();

function providerError(
  code: 'invalid_parameters' | 'credential_unavailable' | 'provider_response_invalid',
): Error {
  return Object.assign(new Error(code), { code });
}

function assertProviderHttpSuccess(status: number): void {
  const httpFailure = classifyVoiceProviderHttpFailure(status);
  if (httpFailure) throw providerError(httpFailure);
}

function readExpiryMs(record: Record<string, unknown>, now: number): number {
  const raw = record.expires_at ?? record.expiresAt;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const value = parseTimestampMs(raw);
    if (value !== null && value > now + 1_000 && value <= now + 10 * 60_000) return value;
  }
  // xAI's endpoint accepts a requested 300-second lifetime but its public example
  // does not promise an expiry field in the response. Bound the artifact locally.
  return now + 300_000;
}

function readBoundedJsonBytes(body: Uint8Array): unknown {
  if (body.byteLength > MAX_RESPONSE_BYTES) throw providerError('provider_response_invalid');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw providerError('provider_response_invalid');
  }
}

function parseAudience(value: string): 'web' | 'native' {
  let rawAudience: unknown;
  try { rawAudience = JSON.parse(value); } catch { throw providerError('invalid_parameters'); }
  const audience = AudienceSchema.safeParse(rawAudience);
  if (!audience.success) throw providerError('invalid_parameters');
  return audience.data.platform;
}

function parseClientAuthArtifact(
  value: unknown,
  platform: 'web' | 'native',
  now: number,
): VoiceClientAuthArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError('provider_response_invalid');
  }
  const record = value as Record<string, unknown>;
  const token = typeof record.value === 'string' ? record.value.trim() : '';
  if (!token || token.length > 16_384) {
    throw providerError('provider_response_invalid');
  }
  const expiresAtMs = readExpiryMs(record, now);
  return platform === 'web'
    ? Object.freeze({
        kind: 'subprotocol_token' as const,
        value: `xai-client-secret.${token}`,
        placement: 'websocket_subprotocol' as const,
        expiresAtMs,
      })
    : Object.freeze({
        kind: 'bearer_token' as const,
        value: token,
        placement: 'authorization_header' as const,
        expiresAtMs,
      });
}

function parseVoiceCatalog(value: unknown): readonly VoiceProviderCatalogItem[] {
  const rows = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).voices
    : null;
  if (!Array.isArray(rows)) throw providerError('provider_response_invalid');
  return Object.freeze(rows.slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const id = typeof (record.voice_id ?? record.id) === 'string' ? String(record.voice_id ?? record.id).trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : id;
    if (!id || id.length > 256 || !name || name.length > 256) return [];
    const metadata: Record<string, string> = {};
    if (typeof record.language === 'string' && record.language.trim()) metadata.language = record.language.trim().slice(0, 512);
    if (typeof record.description === 'string' && record.description.trim()) metadata.description = record.description.trim().slice(0, 512);
    return [Object.freeze({ id, name, metadata: Object.freeze(metadata) })];
  }));
}

export function createXaiRealtimeCredentialOperations(input: Readonly<{
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
      const platform = parseAudience(params.audience);
      const url = `${baseUrl}/realtime/client_secrets`;
      if (baseUrl !== DEFAULT_API_BASE_URL) throw providerError('invalid_parameters');
      const response = await params.accountOperations.request({
        operationId: 'client-auth',
        parameters: Object.freeze({ body: { expires_after: { seconds: 300 } } }),
        signal: params.signal,
      });
      if (response.finalUrl !== url) {
        throw providerError('provider_response_invalid');
      }
      assertProviderHttpSuccess(response.status);
      return parseClientAuthArtifact(readBoundedJsonBytes(response.body), platform, now());
    },
    async fetchCatalogWithAccountOperations(params: Readonly<{
      accountOperations: VoiceAccountOperationService;
      catalog: 'voices' | 'models';
      signal: AbortSignal;
    }>): Promise<readonly VoiceProviderCatalogItem[]> {
      if (params.catalog !== 'voices') throw Object.assign(new Error('operation_unsupported'), { code: 'operation_unsupported' });
      if (baseUrl !== DEFAULT_API_BASE_URL) throw providerError('invalid_parameters');
      const response = await params.accountOperations.request({
        operationId: 'voices',
        parameters: Object.freeze({}),
        signal: params.signal,
      });
      if (response.finalUrl !== `${baseUrl}/tts/voices`) {
        throw providerError('provider_response_invalid');
      }
      assertProviderHttpSuccess(response.status);
      return parseVoiceCatalog(readBoundedJsonBytes(response.body));
    },
  });
}
