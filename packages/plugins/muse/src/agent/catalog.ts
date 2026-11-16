import { PluginError } from '@happier-dev/plugin-sdk';
import { formatReasoningEffortTierLabel } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
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
  applyCurrentReasoningEffort(effort: string): void;
  readCurrentReasoningEffort(): string | undefined;
  observeConfiguration(message: unknown, sessionId: string): void;
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
      // Meta's JSON-schema contract, verified through CLIProxyAPI v8.0.61
      // with this contributor model (2026-11-16). Unknown models stay unknown.
      ...(providerId === 'meta' && modelId === 'muse-spark-1.3-contributor'
        ? { capabilities: { structuredOutput: 'supported' as const } } : {}),
      ...(text(row.description) ? { description: text(row.description) } : {}),
      ...(contextLimit === undefined ? {} : { contextWindowTokens: contextLimit }),
      ...(variants.length === 0 ? {} : { modelOptions: [{ id: 'reasoning_effort', name: 'Reasoning effort',
        type: 'select', currentValue: defaultEffort,
        options: variants.map(value => ({ value, name: formatReasoningEffortTierLabel(value),
          ...(descriptions.has(value) ? { description: descriptions.get(value) } : {}) })),
      }] }),
    };
  });
  return { models, nativeModels, currentModelId };
}

export function createMuseCatalog(client: Pick<PluginJsonRpcClient, 'request'>): MuseCatalog {
  let snapshot: AgentSessionModelsSnapshot = { models: null };
  let nativeModels: readonly MuseNativeModel[] = [];
  // Catalog defaults are offered choices, not evidence of a Session's standing effort.
  let currentReasoningEffort: string | undefined;
  const listeners = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
  const publish = (next: AgentSessionModelsSnapshot) => {
    if (next === snapshot) return snapshot;
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };
  const projectCurrentEffort = (offered: readonly AgentSessionModel[], currentModelId: string | null | undefined) => {
    if (!currentModelId) return offered;
    let changed = false;
    const models = offered.map(model => {
      let modelChanged = false;
      const currentValue = model.id === currentModelId ? currentReasoningEffort ?? null : null;
      const modelOptions = model.modelOptions?.map(option => {
        if (option.id !== 'reasoning_effort' || option.currentValue === currentValue) return option;
        changed = true;
        modelChanged = true;
        return { ...option, currentValue };
      });
      return modelChanged ? { ...model, modelOptions } : model;
    });
    return changed ? models : offered;
  };
  const applyCurrentModel = (model: Readonly<{ providerId: string; modelId: string }>) => {
    const currentModelId = `${model.providerId}/${model.modelId}`;
    if (currentModelId !== snapshot.currentModelId) {
      currentReasoningEffort = undefined;
      publish({ ...snapshot, currentModelId,
        models: snapshot.models && projectCurrentEffort(snapshot.models, currentModelId) });
    }
  };
  const applyCurrentReasoningEffort = (effort: string) => {
    currentReasoningEffort = effort;
    const models = snapshot.models && projectCurrentEffort(snapshot.models, snapshot.currentModelId);
    if (models !== snapshot.models) publish({ ...snapshot, models });
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
      if (parsed.currentModelId && parsed.currentModelId !== snapshot.currentModelId) currentReasoningEffort = undefined;
      const currentModelId = parsed.currentModelId ?? snapshot.currentModelId ?? null;
      const previous = new Map(snapshot.models?.map(model => [model.id, model]));
      // Pre-Session rows retain native offered defaults. A bound Session exposes
      // only accepted effort; neither a new model nor a refresh fabricates it.
      const entries = projectCurrentEffort(parsed.models, currentModelId).map(model => {
        const prior = previous.get(model.id);
        return prior && JSON.stringify(prior) === JSON.stringify(model) ? prior : model;
      });
      const models = snapshot.models && entries.length === snapshot.models.length
        && entries.every((model, index) => model === snapshot.models?.[index]) ? snapshot.models : entries;
      // A catalog without an active row has no new fact about an already-open Session.
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
      const exact = nativeModels.find(model => model.id === id);
      const matches = exact ? [exact] : nativeModels.filter(model => model.modelId === id);
      const selected = matches.length === 1 ? matches[0] : undefined;
      return selected ? { status: 'selected', ...selected } : { status: 'unavailable', reason: 'model_unavailable' };
    },
    applyCurrentModel,
    applyCurrentReasoningEffort,
    readCurrentReasoningEffort: () => currentReasoningEffort,
    observeConfiguration(value, sessionId) {
      const message = record(value);
      const params = record(message?.params);
      if (params?.sessionId !== sessionId) return;
      if (message?.method === 'session/modelChanged') {
        const providerId = text(params.providerId);
        const modelId = text(params.modelId);
        if (providerId && modelId) applyCurrentModel({ providerId, modelId });
      } else if (message?.method === 'session/reasoningEffortChanged') {
        const effort = text(params.reasoningEffort);
        if (effort) applyCurrentReasoningEffort(effort);
      }
    },
  };
}

export const MUSE_MODEL_COMMAND = {
  toolId: 'muse-cli', args: MUSE_MSP_LAUNCH.args,
  environment: MUSE_MSP_LAUNCH.env,
  environmentKeys: MUSE_LAUNCH_ENV_KEYS,
} as const;

/** The host owns the scoped process and supplies its selected native environment. */
export const MUSE_PREFLIGHT_SESSION_CONTROLS = {
  jsonRpcCommands: [MUSE_MODEL_COMMAND],
  probeModels: context => context.withDeclaredJsonRpcClient(MUSE_MODEL_COMMAND, async (client, signal) => {
    await initializeMuseMsp(client, { signal });
    return (await createMuseCatalog(client).refresh({ signal })).models;
  }),
} satisfies AgentPreflightSessionControlsContributionV1;
