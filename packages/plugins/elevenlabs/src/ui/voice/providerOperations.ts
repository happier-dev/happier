import {
  classifyVoiceProviderHttpFailure,
  type VoiceProviderCatalogItem,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type { PluginVoiceAccountOperationService } from '@happier-dev/plugin-sdk/runtime';

import {
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionResponseSchema,
} from '../../protocol/voice/index.js';

function providerError(
  code: 'invalid_parameters' | 'credential_unavailable' | 'provider_response_invalid',
  stage?: ElevenLabsProvisionStage,
): Error {
  return Object.assign(new Error(code), { code, ...(stage ? { stage } : {}) });
}

function assertProviderHttpSuccess(status: number): void {
  const httpFailure = classifyVoiceProviderHttpFailure(status);
  if (httpFailure) throw providerError(httpFailure);
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

function parseVoices(value: unknown): readonly VoiceProviderCatalogItem[] {
  const voices = value && typeof value === 'object' && Array.isArray((value as { voices?: unknown }).voices)
    ? (value as { voices: unknown[] }).voices
    : [];
  const rows: VoiceProviderCatalogItem[] = [];
  for (const raw of voices.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = stringValue(record.voice_id, 256);
    const name = stringValue(record.name, 256);
    if (!id || !name) continue;
    const metadata: Record<string, string> = {};
    if (record.labels && typeof record.labels === 'object' && !Array.isArray(record.labels)) {
      for (const [key, entry] of Object.entries(record.labels as Record<string, unknown>).slice(0, 32)) {
        const normalizedKey = stringValue(key, 64);
        const normalizedValue = stringValue(entry);
        if (normalizedKey
          && normalizedKey !== 'category'
          && normalizedKey !== 'previewUrl'
          && normalizedValue) metadata[normalizedKey] = normalizedValue;
      }
    }
    const category = stringValue(record.category);
    const previewUrl = secureUrlValue(record.preview_url, 'https:');
    if (category) metadata.category = category;
    if (previewUrl) metadata.previewUrl = previewUrl;
    rows.push({ id, name, metadata });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

function parseConversationAuthJson(
  kind: 'token' | 'signed_url',
  value: unknown,
): Readonly<{ kind: 'token' | 'signed_url'; value: string }> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
  const artifact = kind === 'signed_url'
    ? secureUrlValue(record.signed_url, 'wss:')
    : stringValue(record.token, 16_384);
  if (!artifact) throw providerError('provider_response_invalid');
  return Object.freeze({ kind, value: artifact });
}

export async function mintElevenLabsConversationAuthWithAccountOperations(input: Readonly<{
  accountOperations: PluginVoiceAccountOperationService;
  agentId: string;
  textOnly: boolean;
  signal: AbortSignal;
}>): Promise<Readonly<{ kind: 'token' | 'signed_url'; value: string }>> {
  const operationId = input.textOnly ? 'signed-url' : 'conversation-token';
  const response = await input.accountOperations.request({
    operationId,
    parameters: { agentId: input.agentId },
    signal: input.signal,
  });
  assertProviderHttpSuccess(response.status);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    throw providerError('provider_response_invalid');
  }
  return parseConversationAuthJson(input.textOnly ? 'signed_url' : 'token', json);
}

export async function listElevenLabsVoicesWithAccountOperations(input: Readonly<{
  accountOperations: PluginVoiceAccountOperationService;
  signal: AbortSignal;
}>): Promise<readonly VoiceProviderCatalogItem[]> {
  const response = await input.accountOperations.request({
    operationId: 'voices',
    parameters: {},
    signal: input.signal,
  });
  assertProviderHttpSuccess(response.status);
  try {
    return parseVoices(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)));
  } catch (error) {
    if ((error as Readonly<{ code?: unknown }>).code === 'provider_response_invalid') throw error;
    throw providerError('provider_response_invalid');
  }
}

function normalizeToolParameters(value: Record<string, unknown>): VoiceRealtimeJsonValue {
  const result: Record<string, unknown> = { ...value, type: 'object' };
  if (!result.properties || typeof result.properties !== 'object' || Array.isArray(result.properties)) result.properties = {};
  return VoiceRealtimeJsonValueSchema.parse(result);
}

type ElevenLabsProvisionOperationId =
  | 'agents'
  | 'tools'
  | 'create-tool'
  | 'update-tool'
  | 'create-agent'
  | 'update-agent';

type ElevenLabsProvisionStage =
  | 'list_agents'
  | 'list_tools'
  | 'create_tool'
  | 'update_tool'
  | 'create_agent'
  | 'update_agent';

type ElevenLabsProvisionCall = (
  operationId: ElevenLabsProvisionOperationId,
  parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>,
) => Promise<Record<string, unknown>>;

async function callElevenLabsProvisionStage(
  call: ElevenLabsProvisionCall,
  stage: ElevenLabsProvisionStage,
  operationId: ElevenLabsProvisionOperationId,
  parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>,
): Promise<Record<string, unknown>> {
  try {
    return await call(operationId, parameters);
  } catch (error) {
    if (error && typeof error === 'object') {
      try {
        Object.assign(error, { stage });
        throw error;
      } catch (attributedError) {
        if (attributedError === error) throw attributedError;
      }
    }
    throw providerError('provider_response_invalid', stage);
  }
}

async function listElevenLabsProvisionTools(
  call: ElevenLabsProvisionCall,
  desiredNames: ReadonlySet<string>,
): Promise<readonly unknown[]> {
  const tools: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const json = await callElevenLabsProvisionStage(
      call,
      'list_tools',
      'tools',
      cursor ? { cursor } : {},
    );
    if (!Array.isArray(json.tools)) {
      throw providerError('provider_response_invalid', 'list_tools');
    }
    for (const entry of json.tools) {
      if (!entry || typeof entry !== 'object') continue;
      const toolConfig = (entry as { tool_config?: unknown }).tool_config;
      if (!toolConfig || typeof toolConfig !== 'object') continue;
      const record = toolConfig as Readonly<Record<string, unknown>>;
      if (record.type === 'client' && typeof record.name === 'string' && desiredNames.has(record.name)) {
        tools.push(entry);
      }
    }
    if (json.has_more !== true) return tools;
    const nextCursor = stringValue(json.next_cursor, 512);
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw providerError('provider_response_invalid', 'list_tools');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw providerError('provider_response_invalid', 'list_tools');
}

async function runElevenLabsProvision(
  raw: unknown,
  call: ElevenLabsProvisionCall,
): Promise<Readonly<Record<string, unknown>>> {
    const parsed = ElevenLabsProvisionRequestSchema.safeParse(raw);
    if (!parsed.success) throw providerError('invalid_parameters');
    const request = parsed.data;
    if (request.kind !== 'list'
      && new TextEncoder().encode(JSON.stringify(request.tools)).byteLength > 512_000) {
      throw providerError('invalid_parameters');
    }
    if (request.kind === 'list') {
      const json = await callElevenLabsProvisionStage(call, 'list_agents', 'agents', {});
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
    const existingTools = await listElevenLabsProvisionTools(
      call,
      new Set(request.tools.map((tool) => tool.name)),
    );
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
        interruption_mode: 'allow', pre_tool_speech: 'auto',
        tool_call_sound_behavior: 'auto', tool_error_handling_mode: 'passthrough',
      };
      const existingId = stringValue(existing?.id, 256);
      if (existingId) {
        await callElevenLabsProvisionStage(
          call,
          'update_tool',
          'update-tool',
          { toolId: existingId, body: { tool_config: toolConfig } },
        );
        toolIds.push(existingId);
      } else {
        const created = await callElevenLabsProvisionStage(
          call,
          'create_tool',
          'create-tool',
          { body: { tool_config: toolConfig } },
        );
        const id = stringValue(created.id, 256);
        if (!id) throw providerError('provider_response_invalid', 'create_tool');
        toolIds.push(id);
      }
    }
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
      const created = await callElevenLabsProvisionStage(
        call,
        'create_agent',
        'create-agent',
        { body: { name: 'Happier Voice', conversation_config: conversationConfig } },
      );
      const agentId = stringValue(created.agent_id, 256);
      if (!agentId) throw providerError('provider_response_invalid', 'create_agent');
      return { ok: true, agentId };
    }
    await callElevenLabsProvisionStage(
      call,
      'update_agent',
      'update-agent',
      {
        agentId: request.agentId,
        body: { conversation_config: conversationConfig },
      },
    );
    return { ok: true, updated: true };
}

export async function provisionElevenLabsWithAccountOperations(input: Readonly<{
  accountOperations: PluginVoiceAccountOperationService;
  request: unknown;
  signal: AbortSignal;
}>): Promise<Readonly<Record<string, unknown>>> {
  return await runElevenLabsProvision(input.request, async (operationId, parameters) => {
    const response = await input.accountOperations.request({
      operationId,
      parameters,
      signal: input.signal,
    });
    assertProviderHttpSuccess(response.status);
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw providerError('provider_response_invalid');
      }
      return value as Record<string, unknown>;
    } catch (error) {
      if ((error as Readonly<{ code?: unknown }>).code === 'provider_response_invalid') throw error;
      throw providerError('provider_response_invalid');
    }
  });
}
