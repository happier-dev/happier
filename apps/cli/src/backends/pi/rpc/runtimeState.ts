import type { AgentMessage } from '@/agent/core';

import type {
  PiRpcCommandsData,
  PiRpcModelsData,
  PiRpcSessionStatsData,
  PiRpcStateData,
} from './types';
import {
  asFiniteNonNegativeNumber,
  asNonEmptyString,
  asRecord,
  normalizePiThinkingEffort,
  type PiSessionModelState,
} from './rpcSupport';

export async function publishPiRuntimeState(params: Readonly<{
  state: PiRpcStateData;
  currentModelProvider: string | null;
  previousSessionModelState: PiSessionModelState | null;
  modelProviderById: Map<string, string>;
  getAvailableModels: () => Promise<PiRpcModelsData>;
  getCommands: () => Promise<PiRpcCommandsData>;
  emitMessage: (message: AgentMessage) => void;
}>): Promise<Readonly<{
  currentModelProvider: string | null;
  sessionModelState: PiSessionModelState;
}>> {
  const modelRecord = asRecord(params.state.model);
  const currentModelId = asNonEmptyString(modelRecord?.id) ?? '';
  const currentModelProvider = asNonEmptyString(modelRecord?.provider) ?? params.currentModelProvider;
  const thinkingLevelFromState = normalizePiThinkingEffort(params.state.thinkingLevel) ?? 'medium';

  let normalized: PiSessionModelState['availableModels'] =
    (params.previousSessionModelState?.availableModels ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description ?? '',
    }));

  try {
    const available = await params.getAvailableModels();
    const models = Array.isArray(available.models) ? available.models : [];
    params.modelProviderById.clear();
    normalized = models
      .map((entry) => {
        const model = asRecord(entry);
        const id = asNonEmptyString(model?.id);
        const provider = asNonEmptyString(model?.provider);
        if (!id || !provider) return null;
        const name = asNonEmptyString(model?.name) ?? `${provider}/${id}`;
        params.modelProviderById.set(id, provider);
        params.modelProviderById.set(`${provider}/${id}`, provider);
        const supportsThinking = model?.reasoning === true;
        const modelOptions: unknown[] | undefined = supportsThinking
          ? [{
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: thinkingLevelFromState,
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
                { value: 'xhigh', name: 'Max' },
              ],
            }]
          : undefined;
        return {
          id,
          name,
          description: provider,
          ...(modelOptions ? { modelOptions } : {}),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  } catch {
    // Best-effort: model introspection should not block session start/resume.
  }

  const sessionModelState: PiSessionModelState = {
    currentModelId,
    availableModels: normalized,
  };

  params.emitMessage({
    type: 'event',
    name: 'session_models_state',
    payload: sessionModelState,
  });

  try {
    const commands = await params.getCommands();
    const commandList = Array.isArray(commands.commands) ? commands.commands : [];
    const availableCommands = commandList
      .map((entry) => {
        const item = asRecord(entry);
        const name = asNonEmptyString(item?.name);
        if (!name) return null;
        const description = asNonEmptyString(item?.description) ?? undefined;
        return {
          name: name.startsWith('/') ? name : `/${name}`,
          ...(description ? { description } : {}),
        };
      })
      .filter((entry): entry is { name: string; description?: string } => entry !== null);

    params.emitMessage({
      type: 'event',
      name: 'available_commands_update',
      payload: { availableCommands },
    });
  } catch {
    // Best-effort: commands introspection should not block session start/resume.
  }

  return {
    currentModelProvider,
    sessionModelState,
  };
}

export async function resolvePiModelSelection(params: Readonly<{
  modelIdRaw: string;
  modelProviderById: Map<string, string>;
  currentModelProvider: string | null;
  getState: () => Promise<PiRpcStateData>;
}>): Promise<Readonly<{
  provider: string;
  modelId: string;
  currentModelProvider: string | null;
}>> {
  if (params.modelIdRaw.includes('/')) {
    const [provider, ...rest] = params.modelIdRaw.split('/');
    const modelId = rest.join('/').trim();
    const normalizedProvider = provider.trim();
    if (normalizedProvider && modelId) {
      params.modelProviderById.set(modelId, normalizedProvider);
      params.modelProviderById.set(`${normalizedProvider}/${modelId}`, normalizedProvider);
      return { provider: normalizedProvider, modelId, currentModelProvider: normalizedProvider };
    }
  }

  const fromKnownMap = params.modelProviderById.get(params.modelIdRaw);
  if (fromKnownMap) {
    return { provider: fromKnownMap, modelId: params.modelIdRaw, currentModelProvider: params.currentModelProvider };
  }

  if (params.currentModelProvider) {
    return {
      provider: params.currentModelProvider,
      modelId: params.modelIdRaw,
      currentModelProvider: params.currentModelProvider,
    };
  }

  const state = await params.getState();
  const model = asRecord(state.model);
  const provider = asNonEmptyString(model?.provider);
  if (provider) {
    return { provider, modelId: params.modelIdRaw, currentModelProvider: provider };
  }

  throw new Error(`Cannot resolve Pi provider for model "${params.modelIdRaw}"`);
}

export async function publishPiUsageStatsBestEffort(params: Readonly<{
  disposed: boolean;
  hasProcess: boolean;
  lastPublishedUsageKey: string | null;
  getSessionStats: () => Promise<PiRpcSessionStatsData>;
  emitMessage: (message: AgentMessage) => void;
}>): Promise<string | null> {
  if (params.disposed || !params.hasProcess) return params.lastPublishedUsageKey;

  try {
    const stats = await params.getSessionStats();
    const sessionId = asNonEmptyString(stats.sessionId);
    if (!sessionId) return params.lastPublishedUsageKey;

    const assistantMessagesRaw = stats.assistantMessages;
    const assistantMessages =
      typeof assistantMessagesRaw === 'number' && Number.isFinite(assistantMessagesRaw) ? assistantMessagesRaw : null;
    const rawKey = assistantMessages !== null ? `${sessionId}:${assistantMessages}` : sessionId;
    if (params.lastPublishedUsageKey === rawKey) return params.lastPublishedUsageKey;

    const input = asFiniteNonNegativeNumber(stats.tokens?.input);
    const output = asFiniteNonNegativeNumber(stats.tokens?.output);
    const cacheRead = asFiniteNonNegativeNumber(stats.tokens?.cacheRead);
    const cacheWrite = asFiniteNonNegativeNumber(stats.tokens?.cacheWrite);
    const total = asFiniteNonNegativeNumber(stats.tokens?.total);

    const tokens: Record<string, number> = {};
    if (input !== null) tokens.input = input;
    if (output !== null) tokens.output = output;
    if (cacheRead !== null) tokens.cache_read = cacheRead;
    if (cacheWrite !== null) tokens.cache_creation = cacheWrite;
    if (total !== null) tokens.total = total;
    if (Object.keys(tokens).length === 0) return rawKey;

    const costTotal = asFiniteNonNegativeNumber(stats.cost);
    params.emitMessage({
      type: 'token-count',
      key: `pi:${rawKey}`,
      tokens,
      ...(costTotal !== null ? { cost: { total: costTotal } } : {}),
    });
    return rawKey;
  } catch {
    return params.lastPublishedUsageKey;
  }
}
