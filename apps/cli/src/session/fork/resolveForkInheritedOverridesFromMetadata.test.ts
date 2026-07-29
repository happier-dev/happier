import { describe, expect, it } from 'vitest';

import { buildCodexAgentRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor } from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';

import {
  resolveForkInheritedOverridesFromMetadata,
  resolveSessionAgentSpawnInheritedOverridesFromMetadata,
} from './resolveForkInheritedOverridesFromMetadata';

const codexTarget = {
  kind: 'backend' as const,
  backendId: 'codex',
  sourceKind: 'built_in' as const,
};

const claudeTarget = {
  kind: 'backend' as const,
  backendId: 'claude',
  sourceKind: 'built_in' as const,
};

const providerBinding = {
  v: 1 as const,
  connectionId: 'pc_gateway',
  contributionKey: 'acme.gateway/gateway',
  connectionRevision: 1,
  protocol: 'openai-responses' as const,
  materialization: 'engineConfig' as const,
  adapterBindingKey: 'gateway',
  compatibilityFingerprint: 'compatibility:v1:one',
  bindingSecurityFingerprint: 'binding-security:v1:one',
  managedPurposeBindings: {
    v: 1 as const,
    bindings: [{
      purpose: {
        consumer: {
          pluginId: 'happier.provider.gateway',
          localId: 'gateway',
        },
        purpose: 'upstream',
      },
      target: {
        kind: 'group' as const,
        service: {
          pluginId: 'happier.connected-account.openai',
          localId: 'openai',
        },
        groupId: 'team',
      },
    }],
  },
  displaySnapshot: {
    providerName: 'Gateway',
    connectionName: 'Gateway',
    connectionRole: 'default' as const,
    connectionDisplayNameMode: 'automatic' as const,
  },
};

describe('resolveForkInheritedOverridesFromMetadata', () => {
  it('uses canonical legacy normalization before deciding whether a missing agent target is an error', () => {
    for (const modelId of [' default ', '   ', 'invalid legacy model']) {
      expect(resolveForkInheritedOverridesFromMetadata({
        modelOverrideV1: { v: 1, updatedAt: 456, modelId },
      }, null)).toEqual({ spawn: {}, metadata: {} });
    }

    expect(resolveForkInheritedOverridesFromMetadata({
      modelSelectionIntentV1: { v: 1, updatedAt: 455, selection: null },
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'invalid legacy model' },
    }, null)).toEqual({ spawn: {}, metadata: {} });
  });

  it('uses canonical timestamp precedence before deciding whether a missing agent target is an error', () => {
    expect(resolveForkInheritedOverridesFromMetadata({
      modelSelectionIntentV1: { v: 1, updatedAt: 457, selection: null },
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
    }, null)).toEqual({ spawn: {}, metadata: {} });

    expect(() => resolveForkInheritedOverridesFromMetadata({
      modelSelectionIntentV1: { v: 1, updatedAt: 455, selection: null },
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'vendor/model' },
    }, null)).toThrow(expect.objectContaining({
      code: 'model_selection_agent_target_unknown',
    }));
  });

  it('refuses to infer an agent target for a non-empty legacy model selection', () => {
    expect(() => resolveForkInheritedOverridesFromMetadata({
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
    }, null)).toThrow(expect.objectContaining({
      code: 'model_selection_agent_target_unknown',
    }));
  });

  it('refuses a canonical model selection that belongs to another agent target', () => {
    expect(() => resolveForkInheritedOverridesFromMetadata({
      providerBindingV1: { ...providerBinding, connectionId: 'pcn_openrouter_work' },
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 456,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pcn_openrouter_work',
          modelId: 'openai/gpt-test',
        },
      },
    }, claudeTarget)).toThrow(expect.objectContaining({
      code: 'model_selection_agent_target_mismatch',
    }));
  });

  it('inherits a Provider selection only with its exact persisted binding and refuses malformed binding state', () => {
    const metadata = {
      providerBindingV1: providerBinding,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 456,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_gateway',
          modelId: 'vendor/model',
        },
      },
    } as const;

    expect(resolveForkInheritedOverridesFromMetadata(metadata, codexTarget).spawn).toEqual({
      modelSelection: {
        v: 1,
        updatedAt: 456,
        ref: metadata.modelSelectionIntentV1.selection,
      },
      providerBindingMetadataV1: providerBinding,
    });
    expect(() => resolveForkInheritedOverridesFromMetadata({
      ...metadata,
      providerBindingV1: { v: 1, connectionId: 'pc_gateway' },
    }, codexTarget)).toThrow(expect.objectContaining({
      providerError: expect.objectContaining({ code: 'provider_binding_changed', connectionId: 'pc_gateway' }),
    }));
  });

  it('returns spawn seeds plus metadata overrides for valid parent overrides', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      sessionModesV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 459,
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 460,
        currentModelId: 'gpt-5.4',
        availableModels: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
        ],
      },
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'codex',
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
        agentId: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
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
    } as any, codexTarget);

    expect(result.spawn).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      agentModeId: 'plan',
      agentModeUpdatedAt: 457,
      modelSelection: {
        v: 1,
        updatedAt: 456,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-test' },
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 458,
        overrides: {
          speed: { updatedAt: 458, value: 'fast' },
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    });

    expect(result.metadata).toEqual({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 456,
        selection: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-test' },
      },
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      sessionModesV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 459,
        currentModeId: 'plan',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 460,
        currentModelId: 'gpt-5.4',
        availableModels: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
        ],
      },
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'codex',
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
        agentId: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
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
      modelSelectionIntentV1: { v: 1, updatedAt: 456, selection: null },
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
    } as any, codexTarget);

    expect(result.spawn).toEqual({ agentModeId: 'plan', agentModeUpdatedAt: 457 });
    expect(result.metadata).toEqual({
      modelSelectionIntentV1: { v: 1, updatedAt: 456, selection: null },
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'default' },
      sessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
    });
  });

  it('preserves valid model options while dropping malformed option entries without dropping the model', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      sessionModelsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 460,
        currentModelId: 'gpt-5.4',
        availableModels: [
          {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            description: 'Reasoning model',
            modelOptions: [
              {
                id: 'reasoning_effort',
                name: 'Reasoning effort',
                description: 'Controls reasoning depth',
                type: 'select',
                currentValue: 'high',
                options: [
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High', description: 'More reasoning' },
                ],
              },
              {
                id: 'missing-type',
                name: 'Malformed',
                currentValue: 'high',
              },
            ],
          },
        ],
      },
    } as any, codexTarget);

    expect(result.metadata.sessionModelsV1).toEqual({
      v: 1,
      agentId: 'codex',
      updatedAt: 460,
      currentModelId: 'gpt-5.4',
      availableModels: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          description: 'Reasoning model',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Reasoning effort',
              description: 'Controls reasoning depth',
              type: 'select',
              currentValue: 'high',
              options: [
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High', description: 'More reasoning' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('preserves cleared mode overrides in metadata without seeding null spawn values', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 101, modeId: null },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 202, modeId: null },
    } as any, codexTarget);

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
    }, codexTarget);

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
    } as any, codexTarget);

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
          reasoning_effort: { updatedAt: 100, value: 'medium' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 200,
        overrides: {
          reasoning_effort: { updatedAt: 200, value: 'low' },
        },
      },
    } as any, codexTarget);

    expect(result.spawn).toEqual({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 200,
        overrides: {
          reasoning_effort: { updatedAt: 200, value: 'low' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
    });
    expect(result.metadata).toEqual({
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 200,
        overrides: {
          reasoning_effort: { updatedAt: 200, value: 'low' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 200,
        overrides: {
          reasoning_effort: { updatedAt: 200, value: 'low' },
          speed: { updatedAt: 90, value: 'fast' },
        },
      },
    });
  });

  it('keeps fork inheritance scoped away from session-agent spawn-only fields', () => {
    const result = resolveForkInheritedOverridesFromMetadata({
      profileId: 'profile-parent',
      mcpSelectionV1: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['local-search'],
        forceExcludeServerIds: ['prod-browser'],
      },
    } as any, codexTarget);

    expect(result.spawn).toEqual({});
    expect(result.metadata).toEqual({});
  });

  it('resolves session-agent spawn inheritance with spawn-only metadata fields', () => {
    const result = resolveSessionAgentSpawnInheritedOverridesFromMetadata({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          effort: { updatedAt: 458, value: 'xhigh' },
        },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServicesUpdatedAt: 459,
      profileId: 'profile-parent',
      mcpSelectionV1: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['local-search'],
        forceExcludeServerIds: ['prod-browser'],
      },
    } as any, codexTarget);

    expect(result.spawn).toEqual({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
      agentModeId: 'plan',
      agentModeUpdatedAt: 457,
      modelSelection: {
        v: 1,
        updatedAt: 456,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-test' },
      },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 458,
        overrides: {
          effort: { updatedAt: 458, value: 'xhigh' },
        },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServicesUpdatedAt: 459,
      profileId: 'profile-parent',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['local-search'],
        forceExcludeServerIds: ['prod-browser'],
      },
    });
  });
});
