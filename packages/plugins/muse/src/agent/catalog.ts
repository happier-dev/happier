import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentPreflightSessionControlsContributionV1, AgentSessionModel, AgentSessionModelsSnapshot, AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginJsonRpcClient } from '@happier-dev/plugin-sdk/exec/protocol-clients';

import { MUSE_LAUNCH_ENV_KEYS } from './cli.js';
import { initializeMuseMsp, MUSE_MSP_LAUNCH } from './msp.js';

export type MuseNativeModel = Readonly<{
  id: string;
  providerId: string;
  modelId: string;
  isDefault: boolean;
  contextLimit?: number;
  outputLimit?: number;
}>;

export type MuseModelSelection =
  | Readonly<{ status: 'nativeDefault' }>
  | (Readonly<{ status: 'selected' }> & MuseNativeModel)
  | Readonly<{ status: 'unavailable'; reason: 'default_model_unavailable' | 'model_unavailable' }>;

export type MuseCatalog = AgentSessionModelsSource & Readonly<{
  refresh(options?: { signal?: AbortSignal; sessionId?: string }): Promise<AgentSessionModelsSnapshot>;
  resolveModelSelection(id?: string): MuseModelSelection;
  applyCurrentModel(model: Readonly<{ providerId: string; modelId: string }>): void;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function malformed(): never {
  throw new PluginError({ code: 'PLUGIN_EXEC_PROTOCOL_ERROR', retryable: false,
    message: 'Muse returned an invalid native model catalog.', details: { phase: 'model/list' } });
}

function parseCatalog(value: unknown): Readonly<{
  models: readonly AgentSessionModel[];
  nativeModels: readonly MuseNativeModel[];
  currentModelId: string | null;
}> {
  const result = record(value);
  if (!Array.isArray(result?.models)) malformed();
  const nativeModels: MuseNativeModel[] = [];
  let currentModelId: string | null = null;
  const models = result.models.map((value): AgentSessionModel => {
    const row = record(value);
    const providerId = text(row?.providerId) ?? text(result.providerId);
    const modelId = text(row?.modelId);
    if (!row || !providerId || !modelId) malformed();
    const id = `${providerId}/${modelId}`;
    const contextLimit = typeof row.contextLimit === 'number' ? row.contextLimit : undefined;
    const outputLimit = typeof row.outputLimit === 'number' ? row.outputLimit : undefined;
    nativeModels.push({ id, providerId, modelId, isDefault: row.isDefault === true,
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }) });
    if (row.isActive === true) currentModelId = id;
    const descriptions = new Map<string, string>();
    if (Array.isArray(row.reasoningEffortVariants)) {
      for (const value of row.reasoningEffortVariants) {
        const variant = record(value);
        const tier = text(variant?.tier);
        const description = text(variant?.description);
        if (tier && description) descriptions.set(tier, description);
      }
    }
    const variants = Array.isArray(row.variants) ? row.variants.filter((value): value is string => typeof value === 'string') : [];
    const defaultEffort = text(row.defaultReasoningEffort) ?? null;
    return {
      id, name: text(row.displayLabel) ?? modelId,
      ...(text(row.description) ? { description: text(row.description) } : {}),
      ...(contextLimit === undefined ? {} : { contextWindowTokens: contextLimit }),
      ...(variants.length === 0 ? {} : { modelOptions: [{ id: 'reasoning_effort', name: 'Reasoning effort',
        type: 'select', currentValue: defaultEffort,
        options: variants.map(value => ({ value, name: value,
          ...(descriptions.has(value) ? { description: descriptions.get(value) } : {}) })),
      }] }),
    };
  });
  return { models, nativeModels, currentModelId };
}

export function createMuseCatalog(client: Pick<PluginJsonRpcClient, 'request'>): MuseCatalog {
  let snapshot: AgentSessionModelsSnapshot = { models: null };
  let nativeModels: readonly MuseNativeModel[] = [];
  const listeners = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
  const publish = (next: AgentSessionModelsSnapshot) => {
    if (next === snapshot) return snapshot;
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };
  return {
    read: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
    async refresh(options) {
      const parsed = parseCatalog(await client.request('model/list',
        options?.sessionId === undefined ? {} : { sessionId: options.sessionId },
        { signal: options?.signal }));
      nativeModels = parsed.nativeModels;
      const previous = new Map(snapshot.models?.map(model => [model.id, model]));
      const entries = parsed.models.map(model => {
        const prior = previous.get(model.id);
        return prior && JSON.stringify(prior) === JSON.stringify(model) ? prior : model;
      });
      const models = snapshot.models && entries.length === snapshot.models.length
        && entries.every((model, index) => model === snapshot.models?.[index]) ? snapshot.models : entries;
      // A catalog without an active row has no new fact about an already-open Session.
      const currentModelId = parsed.currentModelId ?? snapshot.currentModelId ?? null;
      return publish(models === snapshot.models && currentModelId === snapshot.currentModelId
        ? snapshot : { models, currentModelId });
    },
    resolveModelSelection(id) {
      // Native SessionStartParams explicitly selects its server default when modelId is omitted.
      if (id === undefined) return { status: 'nativeDefault' };
      if (id === 'default') {
        const defaults = nativeModels.filter(model => model.isDefault);
        return defaults.length === 1 ? { status: 'selected', ...defaults[0] }
          : { status: 'unavailable', reason: 'default_model_unavailable' };
      }
      const selected = nativeModels.find(model => model.id === id);
      return selected ? { status: 'selected', ...selected } : { status: 'unavailable', reason: 'model_unavailable' };
    },
    applyCurrentModel(model) {
      const currentModelId = `${model.providerId}/${model.modelId}`;
      if (currentModelId !== snapshot.currentModelId) publish({ ...snapshot, currentModelId });
    },
  };
}

const MUSE_MODEL_COMMAND = {
  toolId: 'muse-cli', args: MUSE_MSP_LAUNCH.args,
  environmentKeys: MUSE_LAUNCH_ENV_KEYS,
} as const;

/** The host owns the scoped process and supplies its selected native environment. */
export const MUSE_PREFLIGHT_SESSION_CONTROLS = {
  jsonRpcCommands: [MUSE_MODEL_COMMAND],
  async prepareLaunchEnvironment({ environment }) {
    return { environment: { ...environment, ...MUSE_MSP_LAUNCH.env }, dispose() {} };
  },
  probeModels: context => context.withDeclaredJsonRpcClient(MUSE_MODEL_COMMAND, async (client, signal) => {
    await initializeMuseMsp(client, { signal });
    return (await createMuseCatalog(client).refresh({ signal })).models;
  }),
} satisfies AgentPreflightSessionControlsContributionV1;
