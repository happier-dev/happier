import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { DetectProviderMcpServersResult } from '@/mcp/providerDetection/detectProviderMcpServers';
import { createDeferred } from '@/testkit/async/deferred';

const {
  fetchSessionById,
  probeAgentConfigOptionsBestEffort,
  probeAgentModesBestEffort,
  probeAgentModelsBestEffort,
  detectProviderMcpServers,
  resolveAvailableAccountSettings,
} = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  probeAgentConfigOptionsBestEffort: vi.fn(),
  probeAgentModesBestEffort: vi.fn(),
  probeAgentModelsBestEffort: vi.fn(),
  detectProviderMcpServers: vi.fn(),
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
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    fetchSessionById.mockReset();
    probeAgentConfigOptionsBestEffort.mockReset();
    probeAgentModesBestEffort.mockReset();
    probeAgentModelsBestEffort.mockReset();
    detectProviderMcpServers.mockReset();
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
      backendTargetKey: 'agent:happier.agent.opencode/opencode',
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
      backendTargetKey: 'agent:happier.agent.opencode/opencode',
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
      backendTargetKey: 'agent:happier.agent.codex/codex',
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
      backendTargetKey: 'agent:happier.agent.claude/claude',
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
        'happier.agent.codex%2Fopenai-codex/work': 'Work Codex',
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
              'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
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
        connectedAccountsV4: [{
          ref: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            accountId: 'work',
          },
          status: 'connected',
          authenticationModeId: 'oauth',
          revisionSemantics: 'legacy_unfenced',
          credentialRevision: null,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth',
          providerIdentity: { accountId: 'acct_secret_should_not_return', email: 'work@example.test' },
          displayName: 'Work account',
          scopes: [],
        }],
        connectedAccountGroupsV4: [{
          v: 1,
          ref: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            groupId: 'team',
          },
          incarnation: 'group-incarnation-1',
          displayName: 'Team Pool',
          policy: { autoSwitch: false },
          activeConnectedAccountId: 'work',
          generation: 4,
          runtimeStateRevision: 0,
          state: {},
          createdAt: 1,
          updatedAt: 1,
          members: [{
            v: 1,
            connectedAccountId: 'work',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 1,
          }],
        }],
      },
    } as any) as any;

    const result = await deps.spawnConnectedServicesList({
      agentId: 'codex',
      backendTargetKey: 'agent:happier.agent.codex/codex',
    });

    expect(result).toEqual({
      agentId: 'codex',
      supportedServiceIds: ['happier.agent.codex/openai-codex'],
      profileOptionsByServiceId: {
        'happier.agent.codex/openai-codex': [
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
        'happier.agent.codex/openai-codex': [
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
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      items: [{ value: 'happier.agent.codex/openai-codex:profile:work', label: 'Work Codex' }],
    });
    expect(JSON.stringify(result)).not.toContain('acct_secret_should_not_return');
  });

  it('previews MCP spawn options through the existing MCP preview owner without returning secret env', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-preview-account' })).toString('base64url')}.signature`, encryption: null };
    const serverHttpBaseUrl = 'https://mcp-preview-home.test';
    const catalog = McpServerCatalogV1Schema.parse({ v: 1,
      servers: [{ id: 'srv-1', name: 'repo-tools', title: 'Repo Tools', transport: 'stdio',
        stdio: { command: 'echo', args: [] }, env: { SECRET_TOKEN: { t: 'literal', v: 'must-not-return' } }, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding', serverId: 'srv-1', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
    });
    const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials));
    const snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey,
      settings: accountSettingsParse({ mcpServersStrictMode: true }), rawSettings: { mcpServersStrictMode: true },
      settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot(snapshot);
    const captured = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials, serverHttpBaseUrl, snapshot, isCurrent: async () => isActiveAccountSettingsSnapshotLifetimeCurrent(captured),
    }));
    // Only Home HTTP and provider OS detection are replaced; catalog admission
    // and the preview projection both exercise their real canonical owners.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.origin !== serverHttpBaseUrl) throw new Error('Preview escaped its captured Home');
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: catalog } } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7,
        content: { t: 'plain', v: { mcpServersStrictMode: true } } } };
      if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (url.pathname === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (url.pathname.startsWith('/v1/account/entity-rows/')) return { status: 404, data: {} };
      throw new Error(`Unexpected preview Home request: ${url.pathname}`);
    });
    const detected: DetectProviderMcpServersResult = {
      servers: [{ provider: 'codex', name: 'detected-codex', transport: 'stdio', stdio: { command: 'codex', args: [] },
        envKeys: ['TOKEN'], source: { kind: 'user', path: '/config/codex' }, enabled: true }],
      warnings: [],
    };
    detectProviderMcpServers.mockResolvedValue(detected);
    const detectIssued = createDeferred<void>();
    const detectReleased = createDeferred<DetectProviderMcpServersResult>();

    const deps = createCliActionInventoryDeps({
      token: credentials.token,
      credentials,
      savedSecretOperationContext: operationContext,
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
      },
    });
    const spawnPreview = deps.spawnMcpServersPreview;
    if (!spawnPreview) throw new Error('MCP preview is not installed');

    try {
      const result = await spawnPreview({
        agentId: 'codex',
        machineId: 'machine-1',
        directory: '/repo',
      });

      expect(result).toMatchObject({
        ok: true,
        items: expect.arrayContaining([
          {
            value: 'managed:srv-1',
            label: 'Repo Tools',
            selected: true,
            selectable: true,
            sourceKind: 'managed',
            authMode: 'plainText',
            availability: 'active',
          },
        ]),
        preview: {
          ok: true,
          builtIn: [expect.objectContaining({ key: 'built-in:happier' })],
          managed: [
            {
              key: 'managed:srv-1',
              serverId: 'srv-1',
              name: 'repo-tools',
              title: 'Repo Tools',
              transport: 'stdio',
              authMode: 'plainText',
              selected: true,
              selectable: true,
              defaultSelected: true,
              availability: 'active',
              sourceKind: 'managed',
              scopeKind: 'allMachines',
            },
          ],
          detected: [expect.objectContaining({ key: 'detected:codex:detected-codex', envKeyCount: 1 })],
        },
      });
      expect(JSON.stringify(result)).not.toContain('must-not-return');
      expect(operationContext.readSnapshot()?.scopeKey).toBe(snapshot.scopeKey);
      detectProviderMcpServers.mockImplementationOnce(async () => { detectIssued.resolve(); return detectReleased.promise; });
      const pendingPreview = spawnPreview({ agentId: 'codex', machineId: 'machine-1', directory: '/repo' });
      await Promise.race([detectIssued.promise, pendingPreview.then(() => {
        throw new Error('Preview returned before its held provider detection completed');
      })]);
      clearActiveAccountSettingsSnapshot();
      setActiveAccountSettingsSnapshot(snapshot);
      detectReleased.resolve(detected);
      await expect(pendingPreview).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
    } finally {
      // Retire finite maintenance before restoring the Home boundary.
      detectReleased.resolve(detected);
      resetActiveAccountSettingsSnapshotForTests();
      await operationContext.isCurrent();
    }
  });

  it('reports opaque profile rows instead of calling the visible prefix complete', async () => {
    resolveAvailableAccountSettings.mockResolvedValue({
      profiles: [
        {
          v: 2, id: 'readable', name: 'Readable', extraEnvironmentVariables: [],
          defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
          compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
        },
        { v: 99, id: 'future', opaque: { untouched: true } },
      ],
    });
    const deps = createCliActionInventoryDeps({
      token: 'token',
      sessionId: 'sess-1',
      probeDeps: createProbeDeps(),
      mode: 'plain',
      ctx: null,
      rawSession: { host: 'local-machine', path: '/repo', metadata: {} },
    });

    await expect(deps.spawnProfilesList?.({})).resolves.toMatchObject({
      coverage: 'unreadable',
      items: [expect.objectContaining({ id: 'readable' })],
    });
  });
});
