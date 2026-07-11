import type { DaemonVoiceClientAuthArtifact, DaemonVoiceProviderCatalogItem } from '@happier-dev/protocol';

import {
  parseElevenLabsConversationAuthAudience,
  ELEVENLABS_VOICE_PROVIDER_ID,
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionResponseSchema,
  type ElevenLabsProvisionRequest,
} from '../../protocol/voice/index.js';

const DEFAULT_API_BASE_URL = 'https://api.elevenlabs.io/v1';
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export type ElevenLabsCredentialProviderOperations = Readonly<{
  mintClientAuth(params: Readonly<{ secret: string; audience: string; signal: AbortSignal }>): Promise<DaemonVoiceClientAuthArtifact>;
  fetchCatalog(params: Readonly<{ secret: string; catalog: 'voices' | 'models'; signal: AbortSignal }>): Promise<readonly DaemonVoiceProviderCatalogItem[]>;
}>;

export type ElevenLabsVoiceAgentEntry = Readonly<{
  kind: 'voice.agent.v1';
  pluginId: 'happier.voice.elevenlabs';
  providerId: 'realtime_elevenlabs';
  credentialOperations: ElevenLabsCredentialProviderOperations;
  provision(params: Readonly<{ secret: string; request: ElevenLabsProvisionRequest; signal: AbortSignal }>): Promise<unknown>;
  provisionSchemas: Readonly<{
    request: typeof ElevenLabsProvisionRequestSchema;
    response: typeof ElevenLabsProvisionResponseSchema;
  }>;
}>;

function providerError(code: 'invalid_parameters' | 'provider_response_invalid'): Error {
  return Object.assign(new Error(code), { code });
}

async function readBoundedJson(response: Response): Promise<unknown> {
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

function stringValue(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max ? result : null;
}

function secureUrlValue(value: unknown, protocol: 'https:' | 'wss:', max = 16_384): string | null {
  const raw = stringValue(value, max);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== protocol || parsed.username || parsed.password || !parsed.hostname) return null;
    return raw;
  } catch {
    return null;
  }
}

function parseVoices(value: unknown): readonly DaemonVoiceProviderCatalogItem[] {
  const voices = value && typeof value === 'object' && Array.isArray((value as { voices?: unknown }).voices)
    ? (value as { voices: unknown[] }).voices
    : [];
  const rows: DaemonVoiceProviderCatalogItem[] = [];
  for (const raw of voices.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = stringValue(record.voice_id, 256);
    const name = stringValue(record.name, 256);
    if (!id || !name) continue;
    const metadata: Record<string, string> = {};
    const category = stringValue(record.category);
    const previewUrl = secureUrlValue(record.preview_url, 'https:');
    if (category) metadata.category = category;
    if (previewUrl) metadata.previewUrl = previewUrl;
    if (record.labels && typeof record.labels === 'object' && !Array.isArray(record.labels)) {
      for (const [key, entry] of Object.entries(record.labels as Record<string, unknown>).slice(0, 32)) {
        const normalizedKey = stringValue(key, 64);
        const normalizedValue = stringValue(entry);
        if (normalizedKey && normalizedValue) metadata[normalizedKey] = normalizedValue;
      }
    }
    rows.push({ id, name, metadata });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export function createElevenLabsCredentialProviderOperations(params?: Readonly<{
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
}>): ElevenLabsCredentialProviderOperations {
  const fetchImpl = params?.fetch ?? globalThis.fetch;
  const baseUrl = (params?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, '');

  async function request(secret: string, path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { 'xi-api-key': secret, accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw providerError('provider_response_invalid');
    }
    return await readBoundedJson(response);
  }

  return Object.freeze({
    async mintClientAuth({ secret, audience, signal }) {
      const target = parseElevenLabsConversationAuthAudience(audience);
      const path = target.kind === 'signed_url'
        ? `/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(target.agentId)}`
        : `/convai/conversation/token?agent_id=${encodeURIComponent(target.agentId)}`;
      const json = await request(secret, path, signal) as Record<string, unknown>;
      const value = target.kind === 'signed_url'
        ? secureUrlValue(json.signed_url, 'wss:')
        : stringValue(json.token, 16_384);
      if (!value) throw providerError('provider_response_invalid');
      return target.kind === 'signed_url'
        ? { kind: 'signed_url', value, placement: 'request_url', expiresAtMs: Date.now() + 55_000 }
        : { kind: 'sdk_token', value, placement: 'provider_sdk_parameter', expiresAtMs: Date.now() + 55_000 };
    },
    async fetchCatalog({ secret, catalog, signal }) {
      if (catalog !== 'voices') throw providerError('invalid_parameters');
      return parseVoices(await request(secret, '/voices', signal));
    },
  });
}

function normalizeToolParameters(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value, type: 'object' };
  if (!result.properties || typeof result.properties !== 'object' || Array.isArray(result.properties)) result.properties = {};
  return result;
}

export function createElevenLabsProvisionOperation(params?: Readonly<{
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
}>) {
  const fetchImpl = params?.fetch ?? globalThis.fetch;
  const baseUrl = (params?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, '');
  return async ({ secret, request: raw, signal }: Readonly<{ secret: string; request: ElevenLabsProvisionRequest; signal: AbortSignal }>) => {
    const request = ElevenLabsProvisionRequestSchema.parse(raw);
    const call = async (path: string, init?: RequestInit) => {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { 'xi-api-key': secret, accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw providerError('provider_response_invalid');
      }
      return await readBoundedJson(response) as Record<string, unknown>;
    };
    if (request.kind === 'list') {
      const json = await call('/convai/agents?search=Happier%20Voice&page_size=50', { method: 'GET' });
      const agents = Array.isArray(json.agents) ? json.agents : [];
      return {
        ok: true,
        agents: agents.slice(0, 50).flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const id = stringValue((entry as Record<string, unknown>).agent_id, 256);
          const name = stringValue((entry as Record<string, unknown>).name, 256);
          return id && name === 'Happier Voice' ? [{ agentId: id, name }] : [];
        }),
      };
    }
    const toolsJson = await call('/convai/tools', { method: 'GET' });
    const existingTools = Array.isArray(toolsJson.tools) ? toolsJson.tools : [];
    const toolIds: string[] = [];
    for (const tool of request.tools) {
      const existing = existingTools.find((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const toolConfig = (entry as { tool_config?: unknown }).tool_config;
        if (!toolConfig || typeof toolConfig !== 'object') return false;
        const record = toolConfig as Record<string, unknown>;
        return record.type === 'client' && record.name === tool.name;
      }) as Record<string, unknown> | undefined;
      const toolConfig = {
        type: 'client', name: tool.name, description: tool.description,
        parameters: normalizeToolParameters(tool.parameters), expects_response: true,
        execution_mode: 'immediate', response_timeout_secs: tool.name === 'spawnSessionPicker' ? 120 : 60,
        disable_interruptions: false, force_pre_tool_speech: false,
        tool_call_sound_behavior: 'auto', tool_error_handling_mode: 'passthrough',
      };
      const existingId = stringValue(existing?.id, 256);
      if (existingId) {
        await call(`/convai/tools/${encodeURIComponent(existingId)}`, { method: 'PATCH', body: JSON.stringify({ tool_config: toolConfig }) });
        toolIds.push(existingId);
      } else {
        const created = await call('/convai/tools', { method: 'POST', body: JSON.stringify({ tool_config: toolConfig }) });
        const id = stringValue(created.id, 256);
        if (!id) throw providerError('provider_response_invalid');
        toolIds.push(id);
      }
    }
    if (new TextEncoder().encode(JSON.stringify(request.tools)).byteLength > 512_000) throw providerError('invalid_parameters');
    const voiceSettings = Object.fromEntries(Object.entries({
      stability: request.tts.voiceSettings.stability,
      similarity_boost: request.tts.voiceSettings.similarityBoost,
      style: request.tts.voiceSettings.style,
      use_speaker_boost: request.tts.voiceSettings.useSpeakerBoost,
      speed: request.tts.voiceSettings.speed,
    }).filter(([, value]) => value !== null));
    const conversationConfig = {
      conversation: { client_events: ['audio', 'interruption', 'agent_response', 'agent_response_correction', 'agent_chat_response_part', 'user_transcript', 'conversation_initiation_metadata', 'client_tool_call', 'agent_tool_response', 'guardrail_triggered'] },
      turn: { turn_timeout: -1 },
      tts: { voice_id: request.tts.voiceId, ...(request.tts.modelId ? { model_id: request.tts.modelId } : {}), ...(Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}) },
      agent: { prompt: { prompt: request.prompt, tool_ids: toolIds } },
    };
    if (request.kind === 'create') {
      const created = await call('/convai/agents/create', { method: 'POST', body: JSON.stringify({ name: 'Happier Voice', conversation_config: conversationConfig }) });
      const agentId = stringValue(created.agent_id, 256);
      if (!agentId) throw providerError('provider_response_invalid');
      return { ok: true, agentId };
    }
    await call(`/convai/agents/${encodeURIComponent(request.agentId)}`, { method: 'PATCH', body: JSON.stringify({ conversation_config: conversationConfig }) });
    return { ok: true, updated: true };
  };
}

export const ELEVENLABS_VOICE_AGENT_ENTRY: ElevenLabsVoiceAgentEntry = Object.freeze({
  kind: 'voice.agent.v1',
  pluginId: 'happier.voice.elevenlabs',
  providerId: ELEVENLABS_VOICE_PROVIDER_ID,
  credentialOperations: createElevenLabsCredentialProviderOperations(),
  provision: createElevenLabsProvisionOperation(),
  provisionSchemas: Object.freeze({
    request: ElevenLabsProvisionRequestSchema,
    response: ElevenLabsProvisionResponseSchema,
  }),
});
