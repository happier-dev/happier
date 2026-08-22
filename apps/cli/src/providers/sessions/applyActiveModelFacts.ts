import {
  applySessionProviderBindingMetadataV1,
  type SessionActiveModelSelectionV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';

export function applyActiveModelFacts(
  metadata: Metadata,
  target: AuthorizedSessionModelTransitionTarget,
  agentId: string,
  activeSelectionV1: SessionActiveModelSelectionV1 | null = null,
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
  const {
    activeSelectionV1: _staleActiveSelection,
    ...stateWithoutActiveSelection
  } = state;

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
                // Producer-declared; only the authoring agent knows what its own toggle does,
                // so this hand-enumerated projection must carry it through verbatim.
                ...(option.overridesWhenOn === undefined
                  ? {}
                  : { overridesWhenOn: option.overridesWhenOn }),
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
      ...stateWithoutActiveSelection,
      agentId,
      updatedAt: Date.now(),
      currentModelId: target.selection.modelId,
      availableModels,
      ...(activeSelectionV1 ? { activeSelectionV1 } : {}),
    },
  };
}
