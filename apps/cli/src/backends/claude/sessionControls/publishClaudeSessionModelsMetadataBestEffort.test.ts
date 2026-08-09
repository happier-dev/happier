import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { publishClaudeSessionModelsMetadataBestEffort } from './publishClaudeSessionModelsMetadataBestEffort';

describe('publishClaudeSessionModelsMetadataBestEffort', () => {
  it('retires effort overrides the runtime can no longer apply', async () => {
    const state: { metadata: Metadata } = {
      metadata: {
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 1,
          overrides: {
            reasoning_effort: { updatedAt: 1, value: 'max' },
            ultracode: { updatedAt: 1, value: 'true' },
            some_other_option: { updatedAt: 1, value: 'keep-me' },
          },
        },
      } as unknown as Metadata,
    };

    await publishClaudeSessionModelsMetadataBestEffort({
      cwd: '/',
      timeoutMs: 250,
      currentModelId: 'claude-sonnet-4-6',
      nowMs: () => 999,
      probeHelpText: async () => 'Claude Code help output without effort',
      session: {
        ensureMetadataSnapshot: async () => state.metadata,
        updateMetadata: async (updater) => {
          state.metadata = updater(state.metadata);
        },
      },
    });

    // Hiding the controls is not enough: the composer emits whatever overrides remain in metadata,
    // so a stale ultracode would keep riding later prompts as an unsupported option.
    const overrides = state.metadata.sessionConfigOptionOverridesV1?.overrides ?? {};
    expect(overrides.reasoning_effort).toBeUndefined();
    expect(overrides.ultracode).toBeUndefined();
    expect(overrides.some_other_option).toEqual({ updatedAt: 1, value: 'keep-me' });
    expect(state.metadata.sessionModelsV1?.availableModels.length).toBeGreaterThan(0);
  });

  it('keeps effort overrides when the runtime still supports --effort', async () => {
    const state: { metadata: Metadata } = {
      metadata: {
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 1,
          overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
        },
      } as unknown as Metadata,
    };

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

    expect(state.metadata.sessionConfigOptionOverridesV1?.overrides.reasoning_effort)
      .toEqual({ updatedAt: 1, value: 'high' });
  });

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
