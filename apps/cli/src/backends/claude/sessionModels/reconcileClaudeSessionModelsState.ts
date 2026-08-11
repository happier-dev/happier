import type { Metadata } from '@/api/types';
import { readNewestSessionModelsMetadataStateV1 } from '@happier-dev/agents';

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModelEntry = SessionModelsState['availableModels'][number];

export type ClaudeSessionModelsPublicationSource = 'catalog' | 'agent_sdk';

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNewestClaudeState(metadata: Metadata | null | undefined): SessionModelsState | null {
  const state = readNewestSessionModelsMetadataStateV1(
    metadata as unknown as Record<string, unknown> | null | undefined,
  ) as SessionModelsState | null;
  return state?.provider === 'claude' ? state : null;
}

function mergeAvailableModels(params: Readonly<{
  existing: readonly SessionModelEntry[];
  incoming: readonly SessionModelEntry[];
  source: ClaudeSessionModelsPublicationSource;
}>): SessionModelEntry[] {
  const existingById = new Map(params.existing.map((model) => [model.id, model]));
  const incomingById = new Map(params.incoming.map((model) => [model.id, model]));

  if (params.source === 'catalog') {
    return [
      ...params.incoming.map((model) => ({ ...existingById.get(model.id), ...model })),
      ...params.existing.filter((model) => !incomingById.has(model.id)),
    ];
  }

  return [
    ...params.existing.map((model) => ({ ...incomingById.get(model.id), ...model })),
    ...params.incoming.filter((model) => !existingById.has(model.id)),
  ];
}

/**
 * Reconcile the two Claude model-list producers without making either publication order observable.
 *
 * The catalog owns the canonical baseline, ordering, and fields for matching ids. Agent SDK facts
 * enrich that baseline and may add SDK-only ids, but a sparse SDK response cannot erase catalog
 * options. Callers publish the returned object to both metadata aliases in one update.
 */
export function reconcileClaudeSessionModelsState(params: Readonly<{
  metadata: Metadata | null | undefined;
  incomingState: SessionModelsState;
  source: ClaudeSessionModelsPublicationSource;
}>): SessionModelsState {
  const existing = readNewestClaudeState(params.metadata);
  if (!existing) return params.incomingState;

  const existingCurrentModelId = normalizeNonEmptyString(existing.currentModelId);
  const incomingCurrentModelId = normalizeNonEmptyString(params.incomingState.currentModelId);
  const currentModelId = params.source === 'catalog'
    ? incomingCurrentModelId || existingCurrentModelId || 'default'
    : existingCurrentModelId && existingCurrentModelId !== 'default'
      ? existingCurrentModelId
      : incomingCurrentModelId || existingCurrentModelId || 'default';

  return {
    ...params.incomingState,
    updatedAt: Math.max(existing.updatedAt, params.incomingState.updatedAt),
    currentModelId,
    availableModels: mergeAvailableModels({
      existing: Array.isArray(existing.availableModels) ? existing.availableModels : [],
      incoming: Array.isArray(params.incomingState.availableModels) ? params.incomingState.availableModels : [],
      source: params.source,
    }),
  };
}
