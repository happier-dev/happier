import { describe, expect, it } from 'vitest';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';

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
          sandbox: { updatedAt: 458, value: 'workspace-write' },
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
          speed: { updatedAt: 458, value: 'fast' },
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
      summary: {
        text: 'Parent session title',
        updatedAt: 464,
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
          sandbox: { updatedAt: 458, value: 'workspace-write' },
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
          speed: { updatedAt: 458, value: 'fast' },
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
      summary: {
        text: 'Parent session title',
        updatedAt: 464,
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
      sessionModeOverrideV1: { v: 1, updatedAt: 202, modeId: null },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 202, modeId: null },
    });
  });

  it('derives connected-service fork inheritance from the provider runtime descriptor', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        providerSessionId: 'codex-thread-parent',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'happier',
        connectedServiceProfileId: 'codex1',
        homePath: '/tmp/codex-home',
      }),
    }, 'codex');

    expect(result.spawn).toEqual({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex1',
          },
        },
      },
    });
    expect(result.metadata).toEqual({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex1',
          },
        },
      },
    });
  });

  it('uses the newest ACP session-mode alias for both metadata and spawn inheritance', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'build' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: 'plan' },
    } as any);

    expect(result.spawn).toEqual({
      agentModeId: 'plan',
      agentModeUpdatedAt: 200,
    });
    expect(result.metadata).toEqual({
      sessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: 'plan' },
    });
  });

  it('inherits ACP config-option overrides per newest alias entry', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 100,
        overrides: {
          effort: { updatedAt: 100, value: 'medium' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 200,
        overrides: {
          effort: { updatedAt: 200, value: 'high' },
        },
      },
    } as any);

    expect(result.metadata).toEqual({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 200,
        overrides: {
          effort: { updatedAt: 200, value: 'high' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 200,
        overrides: {
          effort: { updatedAt: 200, value: 'high' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
    });
  });
});
