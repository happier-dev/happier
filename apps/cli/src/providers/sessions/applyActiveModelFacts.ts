import { applySessionProviderBindingMetadataV1 } from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';

export function applyActiveModelFacts(
  metadata: Metadata,
  target: AuthorizedSessionModelTransitionTarget,
  agentId: string,
): Metadata {
  const withBinding = applySessionProviderBindingMetadataV1(
    metadata,
    target.sessionBindingMetadata,
  ) as Metadata;
  const existingState = withBinding.sessionModelsV1;
  const state = existingState?.agentId === agentId ? existingState : {
    v: 1 as const,
    agentId,
    updatedAt: Date.now(),
    currentModelId: target.selection.modelId,
    availableModels: [],
  };

  type SessionModel = NonNullable<Metadata['sessionModelsV1']>['availableModels'][number];
  const existing = state.availableModels.find(
    (model) => model.id === target.selection.modelId,
  );
  const providerDescriptor = target.providerBinding?.model;
  const activeDescriptor: SessionModel = providerDescriptor
    ? {
        id: providerDescriptor.id,
        name: providerDescriptor.name,
        ...(providerDescriptor.description === undefined
          ? {}
          : { description: providerDescriptor.description }),
        ...(providerDescriptor.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: providerDescriptor.contextWindowTokens }),
        ...(providerDescriptor.extendedContextModelId === undefined
          ? {}
          : { extendedContextModelId: providerDescriptor.extendedContextModelId }),
        ...(providerDescriptor.modelOptions === undefined
          ? {}
          : {
              modelOptions: providerDescriptor.modelOptions.map((option) => ({
                id: option.id,
                name: option.name,
                ...(option.description === undefined
                  ? {}
                  : { description: option.description }),
                type: option.type,
                currentValue: option.currentValue,
                ...(option.options === undefined
                  ? {}
                  : {
                      options: option.options.map((value) => ({
                        value: value.value,
                        name: value.name,
                        ...(value.description === undefined
                          ? {}
                          : { description: value.description }),
                      })),
                    }),
              })),
            }),
      }
    : existing ?? {
        id: target.selection.modelId,
        name: target.selection.modelId,
      };
  const availableModels = state.availableModels.some(
    (model) => model.id === activeDescriptor.id,
  )
    ? state.availableModels.map((model) =>
        model.id === activeDescriptor.id ? activeDescriptor : model)
    : [...state.availableModels, activeDescriptor];
  return {
    ...withBinding,
    sessionModelsV1: {
      ...state,
      agentId,
      updatedAt: Date.now(),
      currentModelId: target.selection.modelId,
      availableModels,
    },
  };
}
