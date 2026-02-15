import { elevenLabsFetchJson } from './elevenLabsApi';
import { buildElevenLabsVoiceAgentPrompt } from '@happier-dev/agents';
import { DEFAULT_ELEVENLABS_VOICE_ID } from './defaults';
import { storage } from '@/sync/domains/state/storage';
import { resolveElevenLabsRequiredClientTools } from './requiredClientTools';

type ElevenLabsTool = {
  id: string;
  tool_config?: {
    type?: string;
    name?: string;
    description?: string;
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

async function createClientTool(apiKey: string, spec: { name: string; description: string }): Promise<string> {
  const json = await elevenLabsFetchJson({
    apiKey,
    path: '/convai/tools',
    init: {
      method: 'POST',
      body: JSON.stringify({
        tool_config: {
          type: 'client',
          name: spec.name,
          description: spec.description,
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

async function ensureClientToolIds(apiKey: string, requiredClientTools: Array<{ name: string; description: string }>): Promise<string[]> {
  const tools = await listTools(apiKey);

  const ids: string[] = [];
  for (const required of requiredClientTools) {
    const existing = tools.find((t) => t.tool_config?.type === 'client' && t.tool_config?.name === required.name);
    if (existing?.id) {
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
  const disabled = Array.isArray(state?.settings?.actionsSettingsV1?.disabledActionIds)
    ? state.settings.actionsSettingsV1.disabledActionIds
    : [];
  const prompt = sanitizeElevenLabsAgentPrompt(buildElevenLabsVoiceAgentPrompt({ disabledActionIds: disabled }));

  const json = await elevenLabsFetchJson({
    apiKey,
    path: '/convai/agents/create',
    init: {
      method: 'POST',
      body: JSON.stringify({
        name: 'Happier Voice',
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
  const disabled = Array.isArray(state?.settings?.actionsSettingsV1?.disabledActionIds)
    ? state.settings.actionsSettingsV1.disabledActionIds
    : [];
  const prompt = sanitizeElevenLabsAgentPrompt(buildElevenLabsVoiceAgentPrompt({ disabledActionIds: disabled }));

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
