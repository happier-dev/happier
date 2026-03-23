import { describe, expect, it } from 'vitest';

import { resolveForkInheritedOverridesFromMetadata } from './resolveForkInheritedOverridesFromMetadata';

describe('resolveForkInheritedOverridesFromMetadata', () => {
  it('returns spawn seeds plus metadata overrides for valid parent overrides', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      sessionModesV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 459,
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      sessionModelsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 460,
        currentModelId: 'gpt-5.4',
        availableModels: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
        ],
      },
      sessionConfigOptionsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 461,
        configOptions: [
          {
            id: 'speed',
            name: 'Speed',
            type: 'string',
            currentValue: 'fast',
          },
        ],
      },
      sessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          speed: { updatedAt: 458, value: 'fast' },
        },
      },
      acpSessionModesV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 462,
        configOptions: [
          {
            id: 'approval',
            name: 'Approval',
            type: 'string',
            currentValue: 'never',
          },
        ],
      },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    } as any);

    expect(result.spawn).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      agentModeId: 'plan',
      agentModeUpdatedAt: 457,
      modelId: 'gpt-test',
      modelUpdatedAt: 456,
    });

    expect(result.metadata).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      sessionModesV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 459,
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      sessionModelsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 460,
        currentModelId: 'gpt-5.4',
        availableModels: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
        ],
      },
      sessionConfigOptionsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 461,
        configOptions: [
          {
            id: 'speed',
            name: 'Speed',
            type: 'string',
            currentValue: 'fast',
          },
        ],
      },
      sessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          speed: { updatedAt: 458, value: 'fast' },
        },
      },
      acpSessionModesV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        provider: 'opencode',
        updatedAt: 462,
        configOptions: [
          {
            id: 'approval',
            name: 'Approval',
            type: 'string',
            currentValue: 'never',
          },
        ],
      },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    });
  });

  it('ignores invalid or cleared values while preserving valid override objects', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      permissionMode: 'not-a-mode',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'default' },
      sessionModesV1: { v: 1, provider: '', updatedAt: 1, currentModeId: 'build', availableModes: [] },
      sessionModelsV1: { v: 1, provider: 'codex', updatedAt: 'bad', currentModelId: 'm1', availableModels: [] },
      sessionConfigOptionsV1: { v: 1, provider: 'codex', updatedAt: 2, configOptions: 'bad' },
      sessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      sessionConfigOptionOverridesV1: { v: 0 },
      acpSessionModesV1: { v: 1, provider: '', updatedAt: 1, currentModeId: 'build', availableModes: [] },
      acpSessionModelsV1: { v: 1, provider: 'opencode', updatedAt: 'bad', currentModelId: 'm1', availableModels: [] },
      acpConfigOptionsV1: { v: 1, provider: 'opencode', updatedAt: 2, configOptions: 'bad' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: { v: 0 },
    } as any);

    expect(result.spawn).toEqual({ agentModeId: 'plan', agentModeUpdatedAt: 457 });
    expect(result.metadata).toEqual({
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'default' },
      sessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
    });
  });

  it('preserves cleared mode overrides in metadata without seeding null spawn values', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 202, modeId: null },
    } as any);

    expect(result.spawn).toEqual({});
    expect(result.metadata).toEqual({
      sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 202, modeId: null },
    });
  });
});
