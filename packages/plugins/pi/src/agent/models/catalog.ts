import type {
  AgentSessionModel,
  AgentSessionModelsSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { PI_PROVIDER_ID } from '../providerBinding.js';

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

export function qualifyPiModelId(providerRaw: unknown, modelIdRaw: unknown, providerModelId?: string): string | null {
  const provider = readString(providerRaw);
  const modelId = readString(modelIdRaw);
  if (!provider || !modelId) return null;
  if (provider === PI_PROVIDER_ID && modelId === providerModelId) return providerModelId;
  const providerPrefix = `${provider}/`;
  return modelId.startsWith(providerPrefix) ? modelId : `${providerPrefix}${modelId}`;
}

export function createPiModelCatalogEntry(params: Readonly<{
  providerModelId?: string;
  provider: unknown;
  modelId: unknown;
  name?: unknown;
  supportsThinking?: boolean;
  thinkingEffort?: unknown;
}>): AgentSessionModel | null {
  const provider = readString(params.provider);
  const id = qualifyPiModelId(provider, params.modelId, params.providerModelId);
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
  providerModelId?: string;
  state: unknown;
  availableModels?: unknown;
  previous?: AgentSessionModelsSnapshot;
  observedAt?: number;
}>): AgentSessionModelsSnapshot | null {
  const state = readRecord(params.state);
  const current = readRecord(state?.model);
  const currentModelId = qualifyPiModelId(current?.provider, current?.id, params.providerModelId);
  const thinkingEffort = normalizeThinkingEffort(state?.thinkingLevel);
  const previousModels = params.previous?.models;
  let models = previousModels ?? null;
  if (params.availableModels !== undefined) {
    const available = readRecord(params.availableModels);
    if (!Array.isArray(available?.models)) return null;
    const rows = available.models;
    const previousById = new Map(previousModels?.map((model) => [model.id, model]));
    models = rows.flatMap((row) => {
      const model = readRecord(row);
      if (!model) return [];
      const entry = createPiModelCatalogEntry({
        providerModelId: params.providerModelId,
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        supportsThinking: model.reasoning === true,
        thinkingEffort,
      });
      if (!entry) return [];
      const previous = previousById.get(entry.id);
      // These are the variable fields produced by this catalog; option labels and values are fixed above.
      return previous && previous.name === entry.name && previous.description === entry.description
        && previous.modelOptions?.[0]?.currentValue === entry.modelOptions?.[0]?.currentValue
        ? [previous] : [entry];
    });
    if (rows.length > 0 && models.length === 0) return null;
  } else if (models) {
    // State refreshes update the normalized catalog, without re-reading the native observation.
    models = models.map((model) => {
      const thinking = model.modelOptions?.[0];
      return !thinking || thinking.currentValue === thinkingEffort ? model : {
        ...model,
        modelOptions: [{ ...thinking, currentValue: thinkingEffort }],
      };
    });
  }
  if (models && previousModels && models.length === previousModels.length
    && models.every((model, index) => model === previousModels[index])) {
    models = previousModels;
  }
  const observedAt = params.observedAt ?? params.previous?.observedAt;
  if (params.previous && params.previous.models === models
    && params.previous.currentModelId === (currentModelId ?? undefined)
    && params.previous.observedAt === observedAt) return params.previous;
  return {
    models,
    // Registry refresh and configured auth establish candidates, not account entitlement.
    catalogConfidence: 'account_unverified',
    ...(currentModelId ? { currentModelId } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
  };
}
