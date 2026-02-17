import { elevenLabsFetchJson } from './elevenLabsApi';
import { buildElevenLabsVoiceAgentPrompt } from '@happier-dev/agents';
import { DEFAULT_ELEVENLABS_VOICE_ID } from './defaults';
import { storage } from '@/sync/domains/state/storage';
import { resolveElevenLabsRequiredClientTools } from './requiredClientTools';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol';
import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';

const HAPPIER_ELEVENLABS_AGENT_NAME = 'Happier Voice';

type ElevenLabsTool = {
  id: string;
  tool_config?: {
    type?: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    expects_response?: boolean;
    response_timeout_secs?: number;
    execution_mode?: string;
    tool_error_handling_mode?: string;
    tool_call_sound_behavior?: string;
  };
};

type ElevenLabsTtsConfigInput = Readonly<{
  voiceId?: string | null;
  modelId?: string | null;
  voiceSettings?: Readonly<{
    stability?: number | null;
    similarityBoost?: number | null;
    style?: number | null;
    useSpeakerBoost?: boolean | null;
    speed?: number | null;
  }> | null;
}>;

function sanitizeElevenLabsAgentPrompt(prompt: string): string {
  // Keep the agent template backend-agnostic (avoid naming other products).
  return String(prompt).replace(/Claude Code/gi, 'the coding assistant');
}

function deriveDisabledVoiceToolActionIds(state: any): readonly string[] {
  const out: string[] = [];
  const shareDeviceInventory = (state as any)?.settings?.voice?.privacy?.shareDeviceInventory !== false;
  const inventoryActionIds = new Set<string>([
    'workspaces.list_recent',
    'paths.list_recent',
    'machines.list',
    'servers.list',
  ]);
  for (const spec of listVoiceToolActionSpecs()) {
    if (!shareDeviceInventory && inventoryActionIds.has(spec.id)) {
      out.push(spec.id);
      continue;
    }
    if (!isActionEnabledInState(state as any, spec.id as any, { surface: 'voice_tool' })) {
      out.push(spec.id);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function normalizeStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildTtsConfig(input?: ElevenLabsTtsConfigInput | null): Record<string, unknown> {
  const voiceId = normalizeStringOrNull(input?.voiceId) ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = normalizeStringOrNull(input?.modelId);

  const rawSettings = input?.voiceSettings ?? null;
  const voiceSettings: Record<string, unknown> = {};
  const setNumber = (key: string, value: unknown) => {
    if (typeof value !== 'number') return;
    if (!Number.isFinite(value)) return;
    voiceSettings[key] = value;
  };
  const setBoolean = (key: string, value: unknown) => {
    if (typeof value !== 'boolean') return;
    voiceSettings[key] = value;
  };

  setNumber('stability', rawSettings?.stability);
  setNumber('similarity_boost', rawSettings?.similarityBoost);
  setNumber('style', rawSettings?.style);
  setNumber('speed', rawSettings?.speed);
  setBoolean('use_speaker_boost', rawSettings?.useSpeakerBoost);

  return {
    voice_id: voiceId,
    ...(modelId ? { model_id: modelId } : null),
    ...(Object.keys(voiceSettings).length > 0 ? { voice_settings: voiceSettings } : null),
  };
}

async function listTools(apiKey: string): Promise<ElevenLabsTool[]> {
  const json = await elevenLabsFetchJson({ apiKey, path: '/convai/tools', init: { method: 'GET' } });
  const tools = (json as any)?.tools;
  return Array.isArray(tools) ? (tools as ElevenLabsTool[]) : [];
}

type ElevenLabsAgentSummary = Readonly<{
  agent_id?: string;
  name?: string;
}> &
  Record<string, unknown>;

async function listAgents(apiKey: string): Promise<ElevenLabsAgentSummary[]> {
  const query = encodeURIComponent(HAPPIER_ELEVENLABS_AGENT_NAME);
  const json = await elevenLabsFetchJson({
    apiKey,
    path: `/convai/agents?search=${query}&page_size=50`,
    init: { method: 'GET' },
  });
  const agents = (json as any)?.agents;
  return Array.isArray(agents) ? (agents as ElevenLabsAgentSummary[]) : [];
}

export async function findExistingHappierElevenLabsAgents(params: { apiKey: string }): Promise<Array<{ agentId: string; name: string }>> {
  const agents = await listAgents(params.apiKey);
  const out: Array<{ agentId: string; name: string }> = [];
  for (const agent of agents) {
    const agentId = typeof agent?.agent_id === 'string' ? agent.agent_id.trim() : '';
    const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
    if (!agentId || !name) continue;
    if (name !== HAPPIER_ELEVENLABS_AGENT_NAME) continue;
    out.push({ agentId, name });
  }
  return out;
}

function normalizeToolParametersSchema(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as any) : {};
  const out: Record<string, unknown> = { ...obj };
  if (out.type !== 'object') {
    out.type = 'object';
  }
  if (!out.properties || typeof out.properties !== 'object') {
    out.properties = {};
  }
  if (out.properties && typeof (out.properties as any).sessionId === 'object') {
    const required = Array.isArray((out as any).required) ? ([...(out as any).required] as string[]) : [];
    if (!required.includes('sessionId')) required.push('sessionId');
    (out as any).required = required;
  }
  return out;
}

function buildClientToolConfig(spec: { name: string; description: string; parameters: unknown }): Record<string, unknown> {
  const resolveTimeoutSecs = (toolName: string): number => {
    // User-in-the-loop tools can take longer than typical tool calls.
    if (toolName === 'spawnSessionPicker') return 300;
    return 60;
  };

  return {
    type: 'client',
    name: spec.name,
    description: spec.description,
    parameters: normalizeToolParametersSchema(spec.parameters),
    expects_response: true,
    execution_mode: 'immediate',
    response_timeout_secs: resolveTimeoutSecs(spec.name),
    disable_interruptions: false,
    force_pre_tool_speech: false,
    tool_call_sound_behavior: 'auto',
    tool_error_handling_mode: 'passthrough',
  };
}

async function createClientTool(apiKey: string, spec: { name: string; description: string; parameters: unknown }): Promise<string> {
  const json = await elevenLabsFetchJson({
    apiKey,
    path: '/convai/tools',
    init: {
      method: 'POST',
      body: JSON.stringify({
        tool_config: {
          ...buildClientToolConfig(spec),
        },
      }),
    },
  });
  const id = (json as any)?.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('ElevenLabs create tool did not return an id');
  }
  return id;
}

async function updateClientTool(apiKey: string, toolId: string, spec: { name: string; description: string; parameters: unknown }): Promise<void> {
  await elevenLabsFetchJson({
    apiKey,
    path: `/convai/tools/${encodeURIComponent(toolId)}`,
    init: {
      method: 'PATCH',
      body: JSON.stringify({
        tool_config: {
          ...buildClientToolConfig(spec),
        },
      }),
    },
  });
}

function needsToolConfigPatch(existing: ElevenLabsTool, desired: { name: string; description: string; parameters: unknown }): boolean {
  const cfg: any = existing.tool_config ?? {};
  if (cfg.type !== 'client') return true;
  if (String(cfg.name ?? '').trim() !== desired.name) return true;
  if (String(cfg.description ?? '').trim() !== desired.description.trim()) return true;
  if (cfg.expects_response !== true) return true;
  if (cfg.execution_mode !== 'immediate') return true;
  // Many existing tools omit response_timeout_secs (server default). Treat missing as 60 to avoid noisy patching,
  // but still patch user-in-the-loop tools that need a longer timeout.
  const existingTimeout = typeof cfg.response_timeout_secs === 'number' && Number.isFinite(cfg.response_timeout_secs)
    ? Number(cfg.response_timeout_secs)
    : 60;
  const desiredTimeout = Number((buildClientToolConfig(desired) as any)?.response_timeout_secs ?? 60);
  if (existingTimeout !== desiredTimeout) return true;
  if (!cfg.parameters || typeof cfg.parameters !== 'object') return true;

  const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  const hasUnsupportedKeywordsDeep = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some((v) => hasUnsupportedKeywordsDeep(v));
    if (!isPlainObject(value)) return false;
    const record = value as Record<string, unknown>;
    if ('additionalProperties' in record) return true;
    if ('oneOf' in record) return true;
    if ('anyOf' in record) return true;
    if ('allOf' in record) return true;
    return Object.values(record).some((v) => hasUnsupportedKeywordsDeep(v));
  };

  const hasRequiredLeafMetadataDeep = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every((v) => hasRequiredLeafMetadataDeep(v));
    if (!isPlainObject(value)) return true;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? String(record.type) : '';

    // ElevenLabs requires at least one of these fields for leaf param types.
    const hasLeafMeta =
      (typeof record.description === 'string' && record.description.trim().length > 0) ||
      typeof record.dynamic_variable === 'string' ||
      record.is_system_provided === true ||
      (typeof record.constant_value === 'string' && record.constant_value.trim().length > 0);

    if (type === 'string' || type === 'number' || type === 'boolean') {
      return hasLeafMeta;
    }

    if (type === 'array') {
      return hasLeafMeta && hasRequiredLeafMetadataDeep(record.items);
    }

    if (type === 'object' || isPlainObject(record.properties)) {
      if (!hasLeafMeta) return false;
      const props = isPlainObject(record.properties) ? (record.properties as Record<string, unknown>) : {};
      return Object.values(props).every((v) => hasRequiredLeafMetadataDeep(v));
    }

    // Unknown schema: treat as needing patch (be conservative).
    return false;
  };

  // Patch historical/invalid tool schemas produced by older builds:
  // - ElevenLabs rejects JSON-schema `additionalProperties`/unions
  // - leaf schemas must include description/dynamic variable metadata
  if (hasUnsupportedKeywordsDeep(cfg.parameters)) return true;
  if (!hasRequiredLeafMetadataDeep(cfg.parameters)) return true;
  return false;
}

async function ensureClientToolIds(apiKey: string, requiredClientTools: Array<{ name: string; description: string; parameters: unknown }>): Promise<string[]> {
  const tools = await listTools(apiKey);

  const ids: string[] = [];
  for (const required of requiredClientTools) {
    const existing = tools.find((t) => t.tool_config?.type === 'client' && t.tool_config?.name === required.name);
    if (existing?.id) {
      if (needsToolConfigPatch(existing, required)) {
        await updateClientTool(apiKey, existing.id, required);
      }
      ids.push(existing.id);
      continue;
    }
    const created = await createClientTool(apiKey, required);
    ids.push(created);
  }
  return ids;
}

export async function createHappierElevenLabsAgent(params: { apiKey: string; tts?: ElevenLabsTtsConfigInput | null }): Promise<{ agentId: string }> {
  const apiKey = params.apiKey;
  const state = storage.getState() as any;
  const required = resolveElevenLabsRequiredClientTools(state);
  const toolIds = await ensureClientToolIds(apiKey, required);
  const disabledActionIds = deriveDisabledVoiceToolActionIds(state);
  const prompt = sanitizeElevenLabsAgentPrompt(buildElevenLabsVoiceAgentPrompt({ disabledActionIds }));

  const json = await elevenLabsFetchJson({
    apiKey,
    path: '/convai/agents/create',
    init: {
      method: 'POST',
      body: JSON.stringify({
        name: HAPPIER_ELEVENLABS_AGENT_NAME,
        conversation_config: {
          tts: buildTtsConfig(params.tts),
          agent: {
            prompt: {
              prompt,
              tool_ids: toolIds,
            },
          },
        },
      }),
    },
  });

  const agentId = (json as any)?.agent_id;
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('ElevenLabs create agent did not return an agent_id');
  }
  return { agentId };
}

export async function updateHappierElevenLabsAgent({
  apiKey,
  agentId,
  tts,
}: {
  apiKey: string;
  agentId: string;
  tts?: ElevenLabsTtsConfigInput | null;
}): Promise<void> {
  const state = storage.getState() as any;
  const required = resolveElevenLabsRequiredClientTools(state);
  const toolIds = await ensureClientToolIds(apiKey, required);
  const disabledActionIds = deriveDisabledVoiceToolActionIds(state);
  const prompt = sanitizeElevenLabsAgentPrompt(buildElevenLabsVoiceAgentPrompt({ disabledActionIds }));

  await elevenLabsFetchJson({
    apiKey,
    path: `/convai/agents/${encodeURIComponent(agentId)}`,
    init: {
      method: 'PATCH',
      body: JSON.stringify({
        conversation_config: {
          tts: buildTtsConfig(tts),
          agent: {
            prompt: {
              prompt,
              tool_ids: toolIds,
            },
          },
        },
      }),
    },
  });
}
