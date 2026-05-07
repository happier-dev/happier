import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { publishClaudeSessionModelsMetadataBestEffort } from './publishClaudeSessionModelsMetadataBestEffort';

describe('publishClaudeSessionModelsMetadataBestEffort', () => {
  it('publishes sessionModelsV1/acpSessionModelsV1 when --effort is supported', async () => {
    const state: { metadata: Metadata } = { metadata: {} as Metadata };

    await publishClaudeSessionModelsMetadataBestEffort({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: 'claude-sonnet-4-6',
      nowMs: () => 999,
      probeHelpText: async () => '  --effort <level>  (low, medium, high, max)',
      session: {
        ensureMetadataSnapshot: async () => state.metadata,
        updateMetadata: async (updater) => {
          state.metadata = updater(state.metadata);
        },
      },
    });

    expect(state.metadata.sessionModelsV1).toEqual(state.metadata.acpSessionModelsV1);
    expect(state.metadata.sessionModelsV1).toEqual(
      expect.objectContaining({
        v: 1,
        provider: 'claude',
        updatedAt: 999,
        currentModelId: 'claude-sonnet-4-6',
        availableModels: expect.any(Array),
      }),
    );
  });

  it('does not publish metadata when currentModelId is blank', async () => {
    const state: { metadata: Metadata } = { metadata: {} as Metadata };

    await publishClaudeSessionModelsMetadataBestEffort({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: '   ',
      nowMs: () => 999,
      probeHelpText: async () => '  --effort <level>  (low, medium, high, max)',
      session: {
        ensureMetadataSnapshot: async () => state.metadata,
        updateMetadata: async (updater) => {
          state.metadata = updater(state.metadata);
        },
      },
    });

    expect(state.metadata.sessionModelsV1).toBeUndefined();
    expect(state.metadata.acpSessionModelsV1).toBeUndefined();
  });

  it('does not reject when metadata persistence fails', async () => {
    await expect(publishClaudeSessionModelsMetadataBestEffort({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: 'claude-sonnet-4-6',
      nowMs: () => 999,
      probeHelpText: async () => '  --effort <level>  (low, medium, high, max)',
      session: {
        ensureMetadataSnapshot: async () => ({} as Metadata),
        updateMetadata: async () => {
          throw new Error('metadata unavailable');
        },
      },
    })).resolves.toBeUndefined();
  });
});
