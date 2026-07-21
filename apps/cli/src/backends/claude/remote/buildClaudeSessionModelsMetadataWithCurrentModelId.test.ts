import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import {
  buildClaudeSessionModelsMetadataFromSupportedModels,
  buildClaudeSessionModelsMetadataWithCurrentModelId,
} from './buildClaudeSessionModelsMetadataFromSupportedModels';

describe('buildClaudeSessionModelsMetadataWithCurrentModelId', () => {
  it('returns null when the current model id is already adopted and no model facts are provided', () => {
    const metadata = {
      sessionModelsV1: {
        v: 1,
        provider: 'claude',
        updatedAt: 1,
        currentModelId: 'claude-haiku-4-5',
        availableModels: [],
      },
      acpSessionModelsV1: {
        v: 1,
        provider: 'claude',
        updatedAt: 1,
        currentModelId: 'claude-haiku-4-5',
        availableModels: [],
      },
    } as unknown as Metadata;

    expect(buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: 'claude-haiku-4-5',
      metadata,
    })).toBeNull();
  });

  it('upserts a current-model entry carrying the direct context window when model facts are provided', () => {
    const update = buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: 'claude-haiku-4-5',
      metadata: null,
      currentModel: { name: 'Haiku 4.5', contextWindowTokens: 200_000 },
    });

    expect(update?.sessionModelsV1).toMatchObject({
      provider: 'claude',
      currentModelId: 'claude-haiku-4-5',
      availableModels: [
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', contextWindowTokens: 200_000 },
      ],
    });
    expect(update?.acpSessionModelsV1).toMatchObject({
      currentModelId: 'claude-haiku-4-5',
      availableModels: [
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', contextWindowTokens: 200_000 },
      ],
    });
  });

  it('updates the window on an existing entry without losing its other facts', () => {
    const metadata = {
      sessionModelsV1: {
        v: 1,
        provider: 'claude',
        updatedAt: 1,
        currentModelId: 'claude-fable-5',
        availableModels: [
          {
            id: 'claude-fable-5',
            name: 'Fable 5',
            description: 'existing description',
            contextWindowTokens: 200_000,
          },
        ],
      },
    } as unknown as Metadata;

    const update = buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: 'claude-fable-5',
      metadata,
      currentModel: { contextWindowTokens: 1_000_000 },
    });

    expect(update?.sessionModelsV1?.availableModels).toEqual([
      {
        id: 'claude-fable-5',
        name: 'Fable 5',
        description: 'existing description',
        contextWindowTokens: 1_000_000,
      },
    ]);
  });

  it('returns null when both the model id and the provided window are already reflected', () => {
    const state = {
      v: 1,
      provider: 'claude',
      updatedAt: 1,
      currentModelId: 'claude-haiku-4-5',
      availableModels: [
        { id: 'claude-haiku-4-5', name: 'Haiku 4.5', contextWindowTokens: 200_000 },
      ],
    };
    const metadata = {
      sessionModelsV1: state,
      acpSessionModelsV1: state,
    } as unknown as Metadata;

    expect(buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: 'claude-haiku-4-5',
      metadata,
      currentModel: { name: 'Haiku 4.5', contextWindowTokens: 200_000 },
    })).toBeNull();
  });

  it('ignores non-positive or non-finite window values', () => {
    const update = buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: 'claude-haiku-4-5',
      metadata: null,
      currentModel: { contextWindowTokens: Number.NaN },
    });

    expect(update?.sessionModelsV1?.availableModels).toEqual([]);
  });

  it('converges current-model updates from the newest valid model-state alias', () => {
    const metadata = {
      sessionModelsV1: {
        v: 1,
        provider: 'claude',
        updatedAt: 10,
        currentModelId: 'claude-stale',
        availableModels: [{ id: 'claude-stale', name: 'Claude Stale' }],
      },
      acpSessionModelsV1: {
        v: 1,
        provider: 'claude',
        updatedAt: 20,
        currentModelId: 'claude-new',
        availableModels: [{ id: 'claude-new', name: 'Claude New' }],
      },
    } as unknown as Metadata;

    const update = buildClaudeSessionModelsMetadataWithCurrentModelId({
      currentModelId: 'claude-next',
      metadata,
      nowMs: () => 30,
    });

    expect(update?.sessionModelsV1).toEqual(update?.acpSessionModelsV1);
    expect(update?.sessionModelsV1).toMatchObject({
      updatedAt: 30,
      currentModelId: 'claude-next',
      availableModels: [{ id: 'claude-new', name: 'Claude New' }],
    });
  });

  it('uses the newest valid alias current model when publishing a refreshed supported list', () => {
    const metadata = {
      sessionModelsV1: {
        v: 1, provider: 'claude', updatedAt: 10, currentModelId: 'claude-stale', availableModels: [],
      },
      acpSessionModelsV1: {
        v: 1, provider: 'claude', updatedAt: 20, currentModelId: 'claude-new', availableModels: [],
      },
    } as unknown as Metadata;

    const update = buildClaudeSessionModelsMetadataFromSupportedModels({
      modelsRaw: [{ value: 'claude-new', displayName: 'Claude New' }],
      metadata,
      nowMs: () => 30,
    });

    expect(update?.sessionModelsV1?.currentModelId).toBe('claude-new');
    expect(update?.acpSessionModelsV1).toEqual(update?.sessionModelsV1);
  });
});
