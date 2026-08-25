/** ElevenLabs Voice account operations with bounded response parsing. */
import {
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice/client';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  classifyVoiceProviderHttpFailure,
  type VoiceAccountOperationService,
} from '@happier-dev/plugin-sdk/voice';
import type { VoiceProviderCatalogItem } from '@happier-dev/plugin-sdk/voice/speech';

import {
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionResponseSchema,
} from '../../protocol/voice/index.js';

function providerError(
  code:
    | 'invalid_parameters'
    | 'credential_unavailable'
    | 'provider_response_invalid'
    | 'voice_not_found',
  stage?: ElevenLabsProvisionStage,
): Error {
  return Object.assign(new Error(code), { code, ...(stage ? { stage } : {}) });
}

function isVoiceAccountOperationCancelled(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as Readonly<{ code?: unknown }>).code === 'voice_account_operation_cancelled';
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

/**
 * The account voice catalog as the provider returns it. `null` means the
 * payload carried no catalog at all, which is an unreadable response rather
 * than an account that owns no voices.
 */
function readVoiceCatalogEntries(value: unknown): readonly unknown[] | null {
  return value && typeof value === 'object' && Array.isArray((value as { voices?: unknown }).voices)
    ? (value as { voices: unknown[] }).voices
    : null;
}

function parseVoices(value: unknown): readonly VoiceProviderCatalogItem[] {
  // Same rule the provisioning stage already enforces in
  // `assertProvisionVoiceOwnedByAccount`: a payload with no `voices` array is
  // unreadable, not an account that owns nothing. Normalizing it to `[]` would
  // tell the user "no voices available" for a malformed provider response.
  const voices = readVoiceCatalogEntries(value);
  if (!voices) throw providerError('provider_response_invalid');
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
  accountOperations: VoiceAccountOperationService;
  agentId: string;
  connectionType: 'websocket' | 'webrtc';
  signal: AbortSignal;
}>): Promise<Readonly<{ kind: 'token' | 'signed_url'; value: string }>> {
  const useSignedWebsocket = input.connectionType === 'websocket';
  const operationId = useSignedWebsocket ? 'signed-url' : 'conversation-token';
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
  return parseConversationAuthJson(useSignedWebsocket ? 'signed_url' : 'token', json);
}

export async function listElevenLabsVoicesWithAccountOperations(input: Readonly<{
  accountOperations: VoiceAccountOperationService;
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

function desiredElevenLabsToolConfig(tool: Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>): VoiceRealtimeJsonValue {
  return VoiceRealtimeJsonValueSchema.parse({
    type: 'client',
    name: tool.name,
    description: tool.description,
    parameters: normalizeToolParameters(tool.parameters),
    expects_response: true,
    execution_mode: 'immediate',
    response_timeout_secs: tool.name === 'spawnSession' ? 120 : 60,
    interruption_mode: 'allow',
    pre_tool_speech: 'auto',
    tool_call_sound_behavior: 'auto',
    tool_error_handling_mode: 'passthrough',
  });
}

function findExactSelectedElevenLabsToolId(
  existingTools: readonly unknown[],
  name: string,
  desiredConfig: VoiceRealtimeJsonValue,
): string | null {
  for (const entry of existingTools) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Readonly<Record<string, unknown>>;
    const id = stringValue(record.id, 256);
    const toolConfig = record.tool_config;
    if (!id || !toolConfig || typeof toolConfig !== 'object' || Array.isArray(toolConfig)) continue;
    const candidate = VoiceRealtimeJsonValueSchema.safeParse(toolConfig);
    const candidateRecord = candidate.success && !Array.isArray(candidate.data)
      && candidate.data !== null && typeof candidate.data === 'object'
      ? candidate.data as Readonly<Record<string, unknown>>
      : null;
    if (candidateRecord?.type === 'client'
      && candidateRecord.name === name
      && pluginJsonValuesEqual(candidateRecord, desiredConfig)) {
      return id;
    }
  }
  return null;
}

type ElevenLabsProvisionOperationId =
  | 'voices'
  | 'agents'
  | 'agent'
  | 'tools'
  | 'create-tool'
  | 'delete-tool'
  | 'create-agent'
  | 'update-agent';

type ElevenLabsProvisionStage =
  | 'validate_voice'
  | 'list_agents'
  | 'read_agent'
  | 'list_tools'
  | 'create_tool'
  | 'delete_tool'
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

/**
 * A persisted `voiceId` outlives the account it came from: rebinding the API
 * key to another ElevenLabs account, or deleting the voice, leaves settings
 * naming a voice the bound account cannot resolve. ElevenLabs only reports that
 * when the agent write itself is rejected, by which point every client tool has
 * already been reconciled. Reading the account catalog first turns that into a
 * typed, actionable refusal issued before the first provider write.
 */
async function assertProvisionVoiceOwnedByAccount(
  call: ElevenLabsProvisionCall,
  voiceId: string,
): Promise<void> {
  const json = await callElevenLabsProvisionStage(call, 'validate_voice', 'voices', {});
  const entries = readVoiceCatalogEntries(json);
  if (!entries) throw providerError('provider_response_invalid', 'validate_voice');
  const owned = entries.some((entry) => entry
    && typeof entry === 'object'
    && stringValue((entry as Record<string, unknown>).voice_id, 256) === voiceId);
  if (!owned) throw providerError('voice_not_found', 'validate_voice');
}

async function listElevenLabsProvisionTools(
  call: ElevenLabsProvisionCall,
  desiredNames: ReadonlySet<string>,
  selectedAgentToolIds: ReadonlySet<string>,
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
      const id = stringValue((entry as Record<string, unknown>).id, 256);
      const toolConfig = (entry as { tool_config?: unknown }).tool_config;
      if (!toolConfig || typeof toolConfig !== 'object') continue;
      const record = toolConfig as Readonly<Record<string, unknown>>;
      if (id
        && selectedAgentToolIds.has(id)
        && record.type === 'client'
        && typeof record.name === 'string'
        && desiredNames.has(record.name)) {
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

/**
 * Agent discovery is a paginated catalog just like tool discovery. The public
 * list response remains bounded, but must not report an empty result merely
 * because the configured agent landed after the first page.
 */
async function listElevenLabsProvisionAgents(
  call: ElevenLabsProvisionCall,
): Promise<readonly Readonly<{ agentId: string; name: string }>[]> {
  const agents: Array<Readonly<{ agentId: string; name: string }>> = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const json = await callElevenLabsProvisionStage(
      call,
      'list_agents',
      'agents',
      cursor ? { cursor } : {},
    );
    if (!Array.isArray(json.agents)) {
      throw providerError('provider_response_invalid', 'list_agents');
    }
    for (const entry of json.agents) {
      if (!entry || typeof entry !== 'object') continue;
      const id = stringValue((entry as Record<string, unknown>).agent_id, 256);
      const name = stringValue((entry as Record<string, unknown>).name, 256);
      if (id && name === 'Happier Voice' && agents.length < 50) {
        agents.push(Object.freeze({ agentId: id, name }));
      }
    }
    if (json.has_more !== true) return agents;
    const nextCursor = stringValue(json.next_cursor, 512);
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw providerError('provider_response_invalid', 'list_agents');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw providerError('provider_response_invalid', 'list_agents');
}

/**
 * Workspace tools are shareable resources. The selected agent's published
 * `tool_ids` are the only provider-owned proof that a tool is eligible for
 * semantic reuse by this request; a matching workspace name is never evidence.
 */
async function readElevenLabsSelectedAgentToolIds(
  call: ElevenLabsProvisionCall,
  agentId: string,
): Promise<ReadonlySet<string>> {
  const agent = await callElevenLabsProvisionStage(
    call,
    'read_agent',
    'agent',
    { agentId },
  );
  if (stringValue(agent.agent_id, 256) !== agentId) {
    throw providerError('provider_response_invalid', 'read_agent');
  }
  const conversationConfig = agent.conversation_config;
  if (conversationConfig === undefined) return new Set();
  if (!conversationConfig || typeof conversationConfig !== 'object' || Array.isArray(conversationConfig)) {
    throw providerError('provider_response_invalid', 'read_agent');
  }
  const agentConfig = (conversationConfig as Readonly<Record<string, unknown>>).agent;
  if (agentConfig === undefined) return new Set();
  if (!agentConfig || typeof agentConfig !== 'object' || Array.isArray(agentConfig)) {
    throw providerError('provider_response_invalid', 'read_agent');
  }
  const prompt = (agentConfig as Readonly<Record<string, unknown>>).prompt;
  if (prompt === undefined) return new Set();
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) {
    throw providerError('provider_response_invalid', 'read_agent');
  }
  const toolIds = (prompt as Readonly<Record<string, unknown>>).tool_ids;
  if (toolIds === undefined) return new Set();
  if (!Array.isArray(toolIds)) throw providerError('provider_response_invalid', 'read_agent');

  const result = new Set<string>();
  for (const toolId of toolIds) {
    const normalized = stringValue(toolId, 256);
    if (!normalized) throw providerError('provider_response_invalid', 'read_agent');
    result.add(normalized);
  }
  return result;
}

async function runElevenLabsProvision(
  raw: unknown,
  call: ElevenLabsProvisionCall,
  isCleanupAuthorityCurrent: () => boolean,
): Promise<Readonly<Record<string, unknown>>> {
  const createdToolIds: string[] = [];
  let mayHaveCreatedToolWithoutId = false;
  let finalAgentWriteStarted = false;
  try {
    const parsed = ElevenLabsProvisionRequestSchema.safeParse(raw);
    if (!parsed.success) throw providerError('invalid_parameters');
    const request = parsed.data;
    if (request.kind !== 'list'
      && new TextEncoder().encode(JSON.stringify(request.tools)).byteLength > 512_000) {
      throw providerError('invalid_parameters');
    }
    if (request.kind === 'list') {
      return {
        ok: true,
        agents: await listElevenLabsProvisionAgents(call),
      };
    }
    await assertProvisionVoiceOwnedByAccount(call, request.tts.voiceId);
    const existingTools = request.kind === 'update'
      ? await listElevenLabsProvisionTools(
        call,
        new Set(request.tools.map((tool) => tool.name)),
        await readElevenLabsSelectedAgentToolIds(call, request.agentId),
      )
      : [];
    const toolIds: string[] = [];
    for (const tool of request.tools) {
      const toolConfig = desiredElevenLabsToolConfig(tool);
      const existingId = findExactSelectedElevenLabsToolId(existingTools, tool.name, toolConfig);
      if (existingId) {
        toolIds.push(existingId);
      } else {
        const created = await callElevenLabsProvisionStage(
          call,
          'create_tool',
          'create-tool',
          { body: { tool_config: toolConfig } },
        );
        const id = stringValue(created.id, 256);
        if (!id) {
          mayHaveCreatedToolWithoutId = true;
          throw providerError('provider_response_invalid', 'create_tool');
        }
        toolIds.push(id);
        createdToolIds.push(id);
      }
    }
    const conversationConfig = {
      conversation: { client_events: ['audio', 'interruption', 'agent_response', 'agent_response_correction', 'agent_chat_response_part', 'user_transcript', 'conversation_initiation_metadata', 'client_tool_call', 'agent_tool_response', 'guardrail_triggered'] },
      tts: {
        voice_id: request.tts.voiceId,
        ...(request.tts.modelId ? { model_id: request.tts.modelId } : {}),
        ...(request.tts.voiceSettings.stability !== null
          ? { stability: request.tts.voiceSettings.stability }
          : {}),
        ...(request.tts.voiceSettings.similarityBoost !== null
          ? { similarity_boost: request.tts.voiceSettings.similarityBoost }
          : {}),
        ...(request.tts.voiceSettings.speed !== null
          ? { speed: request.tts.voiceSettings.speed }
          : {}),
      },
      agent: { prompt: { prompt: request.prompt, tool_ids: toolIds } },
    };
    if (request.kind === 'create') {
      finalAgentWriteStarted = true;
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
    finalAgentWriteStarted = true;
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
  } catch (error) {
    const hasCreatedTools = createdToolIds.length > 0;
    const authorityCancelled = isVoiceAccountOperationCancelled(error);
    let cleanupIncomplete = mayHaveCreatedToolWithoutId
      || (hasCreatedTools && finalAgentWriteStarted)
      || (hasCreatedTools && (authorityCancelled || !isCleanupAuthorityCurrent()));
    if (hasCreatedTools && !cleanupIncomplete) {
      for (let index = createdToolIds.length - 1; index >= 0; index -= 1) {
        if (!isCleanupAuthorityCurrent()) {
          cleanupIncomplete = true;
          break;
        }
        try {
          await callElevenLabsProvisionStage(
            call,
            'delete_tool',
            'delete-tool',
            { toolId: createdToolIds[index]! },
          );
        } catch (cleanupError) {
          cleanupIncomplete = true;
          if (isVoiceAccountOperationCancelled(cleanupError)) break;
        }
      }
    }
    if (cleanupIncomplete && error && typeof error === 'object') {
      try {
        Object.assign(error, { cleanupIncomplete: true });
      } catch {
        // Existing provisioning errors remain the primary failure when immutable.
      }
    }
    throw error;
  }
}

export async function provisionElevenLabsWithAccountOperations(input: Readonly<{
  accountOperations: VoiceAccountOperationService;
  request: unknown;
  signal: AbortSignal;
}>): Promise<Readonly<Record<string, unknown>>> {
  return await runElevenLabsProvision(
    input.request,
    async (operationId, parameters) => {
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
    },
    () => !input.signal.aborted,
  );
}
