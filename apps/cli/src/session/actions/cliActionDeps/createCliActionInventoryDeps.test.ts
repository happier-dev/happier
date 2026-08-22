import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchSessionById,
  probeAgentConfigOptionsBestEffort,
  probeAgentModesBestEffort,
  probeAgentModelsBestEffort,
  detectProviderMcpServers,
  resolveSessionMcpPreview,
  resolveAvailableAccountSettings,
} = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  probeAgentConfigOptionsBestEffort: vi.fn(),
  probeAgentModesBestEffort: vi.fn(),
  probeAgentModelsBestEffort: vi.fn(),
  detectProviderMcpServers: vi.fn(),
  resolveSessionMcpPreview: vi.fn(),
  resolveAvailableAccountSettings: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/settings/accountSettings/resolveAvailableAccountSettings', () => ({
  resolveAvailableAccountSettings,
}));

import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

describe('createCliActionInventoryDeps', () => {
  beforeEach(() => {
    fetchSessionById.mockReset();
    probeAgentConfigOptionsBestEffort.mockReset();
    probeAgentModesBestEffort.mockReset();
    probeAgentModelsBestEffort.mockReset();
    detectProviderMcpServers.mockReset();
    resolveSessionMcpPreview.mockReset();
    resolveAvailableAccountSettings.mockReset();
    resolveAvailableAccountSettings.mockResolvedValue(null);
  });

  const createProbeDeps = () => ({
    probeAgentModelsBestEffort,
    probeAgentModesBestEffort,
    probeAgentConfigOptionsBestEffort,
  });

  it('lists built-in backend models through the canonical dynamic probe when scoped to the session machine', async () => {
    probeAgentModelsBestEffort.mockResolvedValue({
      provider: 'opencode',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
      ],
      supportsFreeform: true,
      source: 'dynamic',
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    });

    await expect(deps.agentsModelsList({
      agentId: 'opencode',
      backendTargetKey: 'backend:opencode',
      machineId: 'local-machine',
      limit: 10,
    })).resolves.toEqual({
      agentId: 'opencode',
      items: [
        { id: 'default', label: 'Default' },
        { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
      ],
      supportsFreeform: true,
      source: 'dynamic',
    });

    expect(probeAgentModelsBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      cwd: '/repo',
      accountSettings: null,
    }));
  });

  it('keeps session metadata models when a local probe is unavailable', async () => {
    probeAgentModelsBestEffort.mockResolvedValue({
      provider: 'opencode',
      availableModels: [],
      supportsFreeform: false,
      source: 'unavailable',
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {
          sessionModelsV1: {
            provider: 'opencode',
            availableModels: [{ id: 'metadata-model', name: 'Metadata Model' }],
          },
        },
      },
    });

    await expect(deps.agentsModelsList({
      agentId: 'opencode',
      backendTargetKey: 'backend:opencode',
      machineId: 'local-machine',
      limit: 10,
    })).resolves.toEqual({
      agentId: 'opencode',
      items: [
        { id: 'default', label: 'Default' },
        { id: 'metadata-model', label: 'Metadata Model' },
      ],
      supportsFreeform: false,
      source: 'session_metadata',
    });
  });

  it('routes configured backend targets into the configured ACP model probe', async () => {
    probeAgentModelsBestEffort.mockResolvedValue({
      provider: 'customAcp',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'configured-model', name: 'Configured Model' },
      ],
      supportsFreeform: true,
      source: 'dynamic',
    });
    resolveAvailableAccountSettings.mockResolvedValue({ acpCatalogSettingsV1: { v: 2, backends: [] } });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    });

    await expect(deps.agentsModelsList({
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      machineId: 'local-machine',
      limit: 10,
    })).resolves.toEqual({
      items: [
        { id: 'default', label: 'Default' },
        { id: 'configured-model', label: 'Configured Model' },
      ],
      supportsFreeform: true,
      source: 'dynamic',
    });

    expect(probeAgentModelsBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo',
      accountSettings: { acpCatalogSettingsV1: { v: 2, backends: [] } },
    }));
  });

  it('reads current account settings for each inventory request instead of caching the first snapshot', async () => {
    resolveAvailableAccountSettings
      .mockResolvedValueOnce({ backendEnabledByTargetKey: { 'backend:codex': false } })
      .mockResolvedValueOnce({ backendEnabledByTargetKey: { 'backend:codex': true } });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    });

    await deps.agentsBackendsList({ includeDisabled: true });
    await deps.agentsBackendsList({ includeDisabled: true });

    expect(resolveAvailableAccountSettings).toHaveBeenCalledTimes(2);
  });

  it('lists agent session modes through the canonical runtime/plugin probe', async () => {
    probeAgentModesBestEffort.mockResolvedValue({
      provider: 'codex',
      availableModes: [
        { id: 'plan', name: 'Plan' },
        { id: 'build', name: 'Build', description: 'Can edit files' },
      ],
      source: 'dynamic',
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    }) as any;

    await expect(deps.agentsSessionModesList({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
      machineId: 'local-machine',
      limit: 1,
    })).resolves.toEqual({
      agentId: 'codex',
      items: [{ id: 'plan', label: 'Plan' }],
      source: 'dynamic',
    });

    expect(probeAgentModesBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      cwd: '/repo',
      accountSettings: null,
    }));
  });

  it('lists config option definitions through the canonical probe without returning current or secret values', async () => {
    probeAgentConfigOptionsBestEffort.mockResolvedValue({
      provider: 'claude',
      source: 'dynamic',
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          description: 'How much reasoning to use',
          type: 'select',
          currentValue: 'secret-current-value',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'xhigh', name: 'X High', description: 'Maximum reasoning' },
          ],
        },
        {
          id: 'ultracode',
          name: 'UltraCode',
          type: 'boolean',
          currentValue: true,
        },
      ],
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
    }) as any;

    const result = await deps.agentsConfigOptionsList({
      agentId: 'claude',
      backendTargetKey: 'backend:claude',
      machineId: 'local-machine',
      modelId: 'claude-opus-4-8',
      limit: 10,
    });

    expect(result).toEqual({
      agentId: 'claude',
      items: [
        {
          id: 'reasoning_effort',
          label: 'Thinking',
          description: 'How much reasoning to use',
          type: 'select',
          options: [
            { value: 'medium', label: 'Medium' },
            { value: 'xhigh', label: 'X High', description: 'Maximum reasoning' },
          ],
        },
        {
          id: 'ultracode',
          label: 'UltraCode',
          type: 'boolean',
        },
      ],
      source: 'dynamic',
    });
    expect(JSON.stringify(result)).not.toContain('secret-current-value');
    expect(probeAgentConfigOptionsBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      cwd: '/repo',
      accountSettings: null,
    }));
  });

  it('projects connected-service spawn options as references without profile secrets', async () => {
    resolveAvailableAccountSettings.mockResolvedValue({
      connectedServicesProfileLabelByKey: {
        'openai-codex/work': 'Work Codex',
      },
      connectedServicesDefaultProfileByServiceId: {
        'openai-codex': 'work',
      },
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
        },
      },
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        path: '/repo',
        metadata: {},
      },
      accountProfile: {
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [
              {
                profileId: 'work',
                status: 'connected',
                kind: 'oauth',
                providerEmail: 'work@example.test',
                providerAccountId: 'acct_secret_should_not_return',
                health: { reconnectRequired: false },
              },
            ],
            groups: [
              {
                groupId: 'team',
                displayName: 'Team Pool',
                activeProfileId: 'work',
                generation: 4,
                memberProfileIds: ['work'],
              },
            ],
          },
        ],
      },
    } as any) as any;

    const result = await deps.spawnConnectedServicesList({
      agentId: 'codex',
      backendTargetKey: 'backend:codex',
    });

    expect(result).toEqual({
      agentId: 'codex',
      supportedServiceIds: ['openai-codex', 'openai'],
      profileOptionsByServiceId: {
        'openai-codex': [
          {
            profileId: 'work',
            status: 'connected',
            kind: 'oauth',
            providerEmail: 'work@example.test',
            label: 'Work Codex',
          },
        ],
      },
      groupOptionsByServiceId: {
        'openai-codex': [
          {
            groupId: 'team',
            label: 'Team Pool',
            activeProfileId: 'work',
            memberProfileIds: ['work'],
            generation: 4,
            enabledMemberCount: 1,
            autoSwitch: false,
            status: 'ready',
          },
        ],
      },
      defaultBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
          openai: { source: 'native' },
        },
      },
      items: [{ value: 'openai-codex:profile:work', label: 'Work Codex' }],
    });
    expect(JSON.stringify(result)).not.toContain('acct_secret_should_not_return');
  });

  it('previews MCP spawn options through the existing MCP preview owner without returning secret env', async () => {
    resolveAvailableAccountSettings.mockResolvedValue({
      mcpServersSettingsV1: {
        v: 1,
        servers: [
          {
            id: 'srv-1',
            name: 'repo-tools',
            command: 'node',
            args: ['server.js'],
            env: { SECRET_TOKEN: 'must-not-return' },
          },
        ],
        bindings: [],
      },
    });
    detectProviderMcpServers.mockResolvedValue({
      servers: [{ provider: 'codex', name: 'detected-codex', command: 'codex', env: { TOKEN: 'secret' } }],
      warnings: [],
    });
    resolveSessionMcpPreview.mockReturnValue({
      ok: true,
      builtIn: [],
      managed: [
        {
          key: 'managed:srv-1',
          serverId: 'srv-1',
          name: 'repo-tools',
          title: 'Repo Tools',
          transport: 'stdio',
          authMode: 'savedSecret',
          selected: true,
          selectable: true,
          defaultSelected: true,
          availability: 'active',
          sourceKind: 'managed',
          scopeKind: 'global',
        },
      ],
      detected: [],
    });

    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: {
        host: 'local-machine',
        machineId: 'machine-1',
        path: '/repo',
        metadata: {},
      },
      mcpPreviewDeps: {
        detectProviderMcpServers,
        resolveSessionMcpPreview,
      },
    }) as any;

    const result = await deps.spawnMcpServersPreview({
      agentId: 'codex',
      machineId: 'machine-1',
      directory: '/repo',
    });

    expect(resolveSessionMcpPreview).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      directory: '/repo',
      agentId: 'codex',
      detectedServers: [{ provider: 'codex', name: 'detected-codex', command: 'codex', env: { TOKEN: 'secret' } }],
    }));
    expect(result).toEqual({
      ok: true,
      items: [
        {
          value: 'managed:srv-1',
          label: 'Repo Tools',
          selected: true,
          selectable: true,
          sourceKind: 'managed',
          authMode: 'savedSecret',
          availability: 'active',
        },
      ],
      preview: {
        ok: true,
        builtIn: [],
        managed: [
          {
            key: 'managed:srv-1',
            serverId: 'srv-1',
            name: 'repo-tools',
            title: 'Repo Tools',
            transport: 'stdio',
            authMode: 'savedSecret',
            selected: true,
            selectable: true,
            defaultSelected: true,
            availability: 'active',
            sourceKind: 'managed',
            scopeKind: 'global',
          },
        ],
        detected: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-return');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
