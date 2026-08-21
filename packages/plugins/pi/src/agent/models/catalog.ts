import type {
  AgentSessionModel,
  AgentSessionModelsSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

type PiThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh';

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function normalizeThinkingEffort(value: unknown): PiThinkingEffort {
  const normalized = readString(value)?.toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return normalized === 'max' ? 'xhigh' : 'medium';
}

export function qualifyPiModelId(providerRaw: unknown, modelIdRaw: unknown): string | null {
  const provider = readString(providerRaw);
  const modelId = readString(modelIdRaw);
  if (!provider || !modelId) return null;
  return modelId.includes('/') ? modelId : `${provider}/${modelId}`;
}

export function createPiModelCatalogEntry(params: Readonly<{
  provider: unknown;
  modelId: unknown;
  name?: unknown;
  supportsThinking?: boolean;
  thinkingEffort?: unknown;
}>): AgentSessionModel | null {
  const provider = readString(params.provider);
  const id = qualifyPiModelId(provider, params.modelId);
  if (!provider || !id) return null;
  const name = readString(params.name) ?? id.slice(id.indexOf('/') + 1);

  return {
    id,
    name,
    description: provider,
    ...(params.supportsThinking === true ? {
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: normalizeThinkingEffort(params.thinkingEffort),
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Max' },
        ],
      }],
    } : {}),
  };
}

export function buildPiRuntimeModelsSnapshot(params: Readonly<{
  state: unknown;
  availableModels: unknown;
}>): AgentSessionModelsSnapshot | null {
  const state = readRecord(params.state);
  const current = readRecord(state?.model);
  const currentModelId = qualifyPiModelId(current?.provider, current?.id);
  const available = readRecord(params.availableModels);
  const rows = Array.isArray(available?.models) ? available.models : [];
  const models = rows.flatMap((row) => {
    const model = readRecord(row);
    if (!model) return [];
    const entry = createPiModelCatalogEntry({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      supportsThinking: model.reasoning === true,
      thinkingEffort: state?.thinkingLevel,
    });
    return entry ? [entry] : [];
  });
  if (models.length === 0) return null;
  return {
    models,
    ...(currentModelId ? { currentModelId } : {}),
  };
}
