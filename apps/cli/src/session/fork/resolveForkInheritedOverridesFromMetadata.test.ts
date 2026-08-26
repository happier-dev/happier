import { describe, expect, it } from 'vitest';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';

import { resolveForkInheritedOverridesFromMetadata } from './resolveForkInheritedOverridesFromMetadata';

describe('resolveForkInheritedOverridesFromMetadata', () => {
  it('returns spawn seeds plus metadata overrides for valid parent overrides', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      summary: { text: '  Migrate Hermes Lite to Happier  ', updatedAt: 122 },
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
      connectedServicesUpdatedAt: 459,
    } as any);

    expect(result.spawn).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      agentModeId: 'plan',
      agentModeUpdatedAt: 457,
      modelId: 'gpt-test',
      modelUpdatedAt: 456,
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
      connectedServicesUpdatedAt: 459,
    });
    expect(result.metadata.summary).toEqual({
      text: 'Migrate Hermes Lite to Happier (fork 1)',
      updatedAt: 122,
    });

    expect(result.metadata).toEqual({
      summary: {
        text: 'Migrate Hermes Lite to Happier (fork 1)',
        updatedAt: 122,
      },
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
      connectedServicesUpdatedAt: 459,
    });
  });

  it('increments an existing fork suffix and accepts the legacy name field as read compatibility', () => {
    expect(resolveForkInheritedOverridesFromMetadata({
      summary: { text: 'Release hardening (fork 7)', updatedAt: 123 },
    }).metadata.summary).toEqual({
      text: 'Release hardening (fork 8)',
      updatedAt: 123,
    });

    expect(resolveForkInheritedOverridesFromMetadata({
      name: 'Legacy fork title',
    }).metadata.summary).toMatchObject({
      text: 'Legacy fork title (fork 1)',
    });
  });

  it('ignores invalid or cleared values while preserving valid override objects', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      name: '   ',
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

  it('derives connected-service fork inheritance from the provider runtime descriptor', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'codex-thread-parent',
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

  it('does not inherit session-agent spawn-only mcp selection or standalone profile id', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      mcpSelectionV1: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: ['legacy-tool'],
      },
      profileId: 'standalone-profile',
    } as any);

    expect(result.spawn).toEqual({});
    expect(result.metadata).toEqual({});
    expect('mcpSelection' in result.spawn).toBe(false);
    expect('profileId' in result.spawn).toBe(false);
    expect('mcpSelectionV1' in result.metadata).toBe(false);
    expect('profileId' in result.metadata).toBe(false);
  });
});
