import type { reconcileClaudeSessionModelsState } from './reconcileClaudeSessionModelsState';
import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';

import { buildClaudeSessionModelsMetadataWithCurrentModelId } from '../remote/buildClaudeSessionModelsMetadataFromSupportedModels';

export type ClaudeEffectiveModelUpdateSource = 'statusline' | 'transcript' | 'sdk' | 'control';
export type ClaudeEffectiveModelObservation = Readonly<{ modelId: string; reasoningEffort?: string }>;

type ClaudeEffectiveModelUpdateClient = Readonly<{
  sendSessionEvent(event: { type: 'message'; message: string }, id?: string): void;
  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  getMetadataSnapshot?: () => Metadata | null;
}>;

type EffectiveModelState = {
  lastSeenModelId: string | null;
  lastMetadataRequestKey: string | null;
  lastEmittedTransitionKey: string | null;
};

const stateByClient = new WeakMap<object, EffectiveModelState>();

function stateFor(client: object): EffectiveModelState {
  const existing = stateByClient.get(client);
  if (existing) return existing;
  const created: EffectiveModelState = {
    lastSeenModelId: null,
    lastMetadataRequestKey: null,
    lastEmittedTransitionKey: null,
  };
  stateByClient.set(client, created);
  return created;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModelEntry = NonNullable<SessionModelsState['availableModels']>[number];

function readClaudeSessionModelsState(metadata: Metadata | null | undefined): SessionModelsState | null {
  const primary = metadata?.sessionModelsV1;
  if (primary?.provider === 'claude') return primary;
  const legacy = metadata?.acpSessionModelsV1;
  if (legacy?.provider === 'claude') return legacy;
  return null;
}

function readActiveClaudeModelId(metadata: Metadata | null | undefined): string | null {
  return readString(readClaudeSessionModelsState(metadata)?.currentModelId);
}

function findSessionModelEntry(
  metadata: Metadata | null | undefined,
  modelId: string,
): SessionModelEntry | null {
  const state = readClaudeSessionModelsState(metadata);
  const entries = Array.isArray(state?.availableModels) ? state.availableModels : [];
  return entries.find((entry) => entry.id === modelId) ?? null;
}

function hasRequestedModelDetails(params: Readonly<{
  metadata: Metadata | null | undefined;
  modelId: string;
  displayName: string | null;
  contextWindowTokens: number | null;
  reasoningEffort: string | null;
}>): boolean {
  if (params.displayName === null && params.contextWindowTokens === null && params.reasoningEffort === null) return true;
  const entry = findSessionModelEntry(params.metadata, params.modelId);
  if (!entry) return false;
  if (params.displayName !== null && entry.name !== params.displayName) return false;
  if (params.contextWindowTokens !== null && entry.contextWindowTokens !== params.contextWindowTokens) return false;
  const effortOption = entry.modelOptions?.find(option => option.id === 'reasoning_effort');
  if (params.reasoningEffort !== null && effortOption && effortOption.currentValue !== params.reasoningEffort) return false;
  return true;
}

function readMetadataSnapshot(client: ClaudeEffectiveModelUpdateClient): Metadata | null {
  try {
    return client.getMetadataSnapshot?.() ?? null;
  } catch {
    return null;
  }
}

function buildMetadataRequestKey(params: Readonly<{
  modelId: string;
  displayName: string | null;
  contextWindowTokens: number | null;
  reasoningEffort: string | null;
}>): string {
  return `${params.modelId}|${params.displayName ?? ''}|${params.contextWindowTokens ?? ''}|${params.reasoningEffort ?? ''}`;
}

function buildModelChangedEventId(params: Readonly<{
  fromModelId: string;
  toModelId: string;
}>): string {
  return `claude:model-changed:${encodeURIComponent(params.fromModelId)}:${encodeURIComponent(params.toModelId)}`;
}

function resolveModelLabel(params: Readonly<{
  metadata: Metadata | null | undefined;
  modelId: string;
  displayName: string | null;
}>): string {
  return params.displayName ?? readString(findSessionModelEntry(params.metadata, params.modelId)?.name) ?? params.modelId;
}

export function applyClaudeEffectiveModelUpdate(params: Readonly<{
  client: ClaudeEffectiveModelUpdateClient;
  reconcileModels?: typeof reconcileClaudeSessionModelsState;
  modelId?: string | null;
  displayName?: string | null;
  contextWindowTokens?: number | null;
  reasoningEffort?: string | null;
  source: ClaudeEffectiveModelUpdateSource;
  logPrefix: string;
}>): void {
  const state = stateFor(params.client);
  // Effort-only control evidence can refine the last observed model, never a catalog/selection seed.
  const modelId = readString(params.modelId) ?? state.lastSeenModelId;
  if (!modelId) return;

  const displayName = readString(params.displayName);
  const contextWindowTokens = readPositiveTokens(params.contextWindowTokens);
  const reasoningEffort = readString(params.reasoningEffort);
  const metadataSnapshot = readMetadataSnapshot(params.client);
  const previousModelId = readActiveClaudeModelId(metadataSnapshot) ?? state.lastSeenModelId;
  const metadataRequestKey = buildMetadataRequestKey({ modelId, displayName, contextWindowTokens, reasoningEffort });

  const alreadyAppliedInMemory = state.lastSeenModelId === modelId;
  const appliedModel = metadataSnapshot?.sessionAppliedModelV1;
  const shouldUpdateMetadata =
    appliedModel?.provider !== 'claude' || appliedModel.modelId !== modelId
    || (!alreadyAppliedInMemory && previousModelId !== modelId)
    || !hasRequestedModelDetails({ metadata: metadataSnapshot, modelId, displayName, contextWindowTokens, reasoningEffort });
  // Even when metadata already matches, record the live observation in the session's source
  // contributions so a later catalog/SDK publication cannot replace it with a catalog estimate.
  if (!shouldUpdateMetadata && params.reconcileModels) {
    buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: modelId,
      metadata: metadataSnapshot,
      reconcileModels: params.reconcileModels,
      currentModel: {
        ...(displayName ? { name: displayName } : {}),
        ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    });
  }
  if (shouldUpdateMetadata && state.lastMetadataRequestKey !== metadataRequestKey) {
    state.lastMetadataRequestKey = metadataRequestKey;
    updateMetadataBestEffort(
      params.client,
      (metadata) => ({
        ...metadata,
        // Observed Claude runtime evidence owns Running; prompt acceptance proves input custody only.
        sessionAppliedModelV1: metadata.sessionAppliedModelV1?.provider === 'claude'
          && metadata.sessionAppliedModelV1.modelId === modelId
          ? metadata.sessionAppliedModelV1
          : { v: 1, provider: 'claude', modelId, updatedAt: Date.now() },
        ...(buildClaudeSessionModelsMetadataWithCurrentModelId({
          currentModelId: modelId,
          reconcileModels: params.reconcileModels,
          metadata,
          currentModel: {
            ...(displayName ? { name: displayName } : {}),
            ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          },
        }) ?? {}),
      }),
      params.logPrefix,
      'runtime_model_update',
    );
  }

  if (previousModelId && previousModelId !== modelId) {
    const transitionKey = `${previousModelId}\u0000${modelId}`;
    if (state.lastEmittedTransitionKey !== transitionKey) {
      state.lastEmittedTransitionKey = transitionKey;
      params.client.sendSessionEvent(
        {
          type: 'message',
          message: `Model changed to ${resolveModelLabel({ metadata: metadataSnapshot, modelId, displayName })}`,
        },
        buildModelChangedEventId({ fromModelId: previousModelId, toModelId: modelId }),
      );
    }
  }

  state.lastSeenModelId = modelId;
}
