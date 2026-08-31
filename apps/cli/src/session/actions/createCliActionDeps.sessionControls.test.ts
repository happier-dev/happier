import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import {
  ReviewStartInputSchema,
  SessionUsageLimitRecoveryOperationResultV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(async (): Promise<unknown> => ({ status: 200, data: { id: 'acct_1', connectedServicesV2: [] } })),
  bootstrapAccountSettingsContext: vi.fn(async (): Promise<unknown> => ({ settings: {}, settingsVersion: 1, loadedAtMs: 1 })),
  callSessionRpc: vi.fn(async () => ({ ok: true })),
  callMachineRpc: vi.fn(async (_params: unknown): Promise<unknown> => ({ type: 'success', sessionId: 'sess_1' })),
  createSpawnedSession: vi.fn(async () => ({
    sessionId: 'spawned_1',
    created: true,
    session: { id: 'spawned_1' },
  })),
  detectProviderMcpServers: vi.fn(async (): Promise<unknown> => ({ servers: [], warnings: [] })),
  getSessionCatalogControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  getSessionGoalControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  getSessionUsageLimitRecoveryControlAdapter: vi.fn(async (_agentId?: unknown): Promise<unknown> => null),
  notifyDaemonConnectedServiceRuntimeAuthFailure: vi.fn(async (_body: unknown) => ({
    ok: true,
    result: {
      status: 'switch_attempted',
      result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
    },
  })),
  updateSessionMetadataWithRetry: vi.fn(async (params: {
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
  }) => ({
    version: 2,
    metadata: params.updater({ machineId: 'machine-local' }),
  })),
  getSessionEvents: vi.fn(async () => ({ ok: true, sessionId: 'sess_1', items: [], nextCursor: null, hasMore: false })),
  getSessionTranscript: vi.fn(async () => ({ ok: true, sessionId: 'sess_1', items: [], nextCursor: null, hasMore: false })),
  listSessions: vi.fn(async (): Promise<unknown> => ({ sessions: [], nextCursor: null })),
  listDaemonStatusesForAllKnownServers: vi.fn(async (): Promise<unknown> => []),
  readSettings: vi.fn(async () => ({ machineId: 'machine-local' })),
  resolveCliFeatureDecisionForServer: vi.fn(async (_params?: unknown): Promise<unknown> => ({ decision: { state: 'enabled' } })),
  resolveSessionTransportContext: vi.fn(async (): Promise<unknown> => ({
    ok: true as const,
    sessionId: 'sess_1',
    rawSession: { active: true },
    ctx: {
      encryptionKey: new Uint8Array(32).fill(3),
      encryptionVariant: 'legacy' as const,
    },
    mode: 'plain' as const,
  })),
  sendSessionMessage: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('axios', () => ({
  default: { get: mocks.axiosGet },
  get: mocks.axiosGet,
}));
vi.mock('@/backends/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/backends/catalog')>()),
  getSessionCatalogControlAdapter: mocks.getSessionCatalogControlAdapter,
  getSessionGoalControlAdapter: mocks.getSessionGoalControlAdapter,
  getSessionUsageLimitRecoveryControlAdapter: mocks.getSessionUsageLimitRecoveryControlAdapter,
}));
vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: mocks.resolveCliFeatureDecisionForServer,
}));
vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: mocks.bootstrapAccountSettingsContext,
}));
vi.mock('@/mcp/providerDetection/detectProviderMcpServers', () => ({
  detectProviderMcpServers: mocks.detectProviderMcpServers,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readSettings: mocks.readSettings,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: mocks.callSessionRpc }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: mocks.callMachineRpc }));
vi.mock('@/session/services/createSpawnedSession', () => ({ createSpawnedSession: mocks.createSpawnedSession }));
vi.mock('@/session/services/getSessionEvents', () => ({ getSessionEvents: mocks.getSessionEvents }));
vi.mock('@/session/services/getSessionTranscript', () => ({ getSessionTranscript: mocks.getSessionTranscript }));
vi.mock('@/session/services/listSessions', () => ({ listSessions: mocks.listSessions }));
vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: mocks.listDaemonStatusesForAllKnownServers,
}));
vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/session/services/sendSessionMessage', () => ({ sendSessionMessage: mocks.sendSessionMessage }));
vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: mocks.updateSessionMetadataWithRetry,
}));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mocks.notifyDaemonConnectedServiceRuntimeAuthFailure,
}));

import { createCliActionDeps, createCliActionInventoryDeps } from './createCliActionDeps';

function createCredentials(): Credentials {
  return {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(9),
    },
  };
}

function parseUsageLimitResult(value: unknown) {
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse(value);
}

describe('createCliActionDeps session controls', () => {
  beforeEach(() => {
    mocks.axiosGet.mockReset();
    mocks.axiosGet.mockResolvedValue({ status: 200, data: { id: 'acct_1', connectedServicesV2: [] } });
    mocks.bootstrapAccountSettingsContext.mockReset();
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({ settings: {}, settingsVersion: 1, loadedAtMs: 1 });
    mocks.callSessionRpc.mockReset();
    mocks.callSessionRpc.mockResolvedValue({ ok: true });
    mocks.callMachineRpc.mockReset();
    mocks.callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'sess_1' });
    mocks.createSpawnedSession.mockReset();
    mocks.createSpawnedSession.mockResolvedValue({
      sessionId: 'spawned_1',
      created: true,
      session: { id: 'spawned_1' },
    });
    mocks.detectProviderMcpServers.mockReset();
    mocks.detectProviderMcpServers.mockResolvedValue({ servers: [], warnings: [] });
    mocks.getSessionCatalogControlAdapter.mockReset();
    mocks.getSessionCatalogControlAdapter.mockResolvedValue(null);
    mocks.getSessionGoalControlAdapter.mockReset();
    mocks.getSessionGoalControlAdapter.mockResolvedValue(null);
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockReset();
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockResolvedValue(null);
    mocks.notifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mocks.notifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    });
    mocks.updateSessionMetadataWithRetry.mockReset();
    mocks.updateSessionMetadataWithRetry.mockImplementation(async (params: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: params.updater({ machineId: 'machine-local' }),
    }));
    mocks.getSessionEvents.mockClear();
    mocks.getSessionTranscript.mockClear();
    mocks.listSessions.mockClear();
    mocks.listDaemonStatusesForAllKnownServers.mockReset();
    mocks.listDaemonStatusesForAllKnownServers.mockResolvedValue([]);
    mocks.readSettings.mockReset();
    mocks.readSettings.mockResolvedValue({ machineId: 'machine-local' });
    mocks.resolveCliFeatureDecisionForServer.mockReset();
    mocks.resolveCliFeatureDecisionForServer.mockResolvedValue({ decision: { state: 'enabled' } });
    mocks.resolveSessionTransportContext.mockReset();
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: { active: true },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    mocks.sendSessionMessage.mockClear();
  });

  it('lists models from provider probes instead of stale current-session metadata', async () => {
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        path: '/repo',
        metadata: {
          happierSessionModelsStateV1: {
            provider: 'claude',
            availableModels: [{ id: 'stale-current-session-only', name: 'Stale metadata model' }],
          },
        },
      },
    });

    const result = await deps.agentsModelsList({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      limit: 200,
    }) as { source?: string; items?: readonly { id?: string }[] };

    expect(result.source).toBe('static');
    expect(result.items?.some((item) => item.id === 'stale-current-session-only')).toBe(false);
    expect(result.items?.some((item) => item.id === 'claude-opus-4-8')).toBe(true);
  });

  it('lists session mode identifiers without transforming provider-owned bytes', async () => {
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      mode: 'plain',
      rawSession: {
        metadata: {
          sessionModesV1: {
            v: 1,
            provider: 'cursor',
            updatedAt: 1,
            currentModeId: ' plan ',
            availableModes: [{ id: ' plan ', name: 'Plan' }],
          },
        },
      },
    });

    const result = await deps.sessionModesList?.({ sessionId: 'sess_1' });
    expect(result).toEqual({
      sessionId: 'sess_1',
      items: [{ id: ' plan ', label: 'Plan' }],
    });
  });

  it('lazily resolves current-session transport when inventory metadata was not seeded', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        metadata: {
          sessionModesV1: {
            v: 1,
            provider: 'cursor',
            updatedAt: 1,
            availableModes: [{ id: 'agent', name: 'Agent' }],
          },
        },
      },
      ctx: { encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'legacy' as const },
      mode: 'plain' as const,
    });
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      mode: 'plain',
      rawSession: null,
    });

    await expect(deps.sessionModesList?.({ sessionId: 'sess_1' })).resolves.toEqual({
      sessionId: 'sess_1',
      items: [{ id: 'agent', label: 'Agent' }],
    });
    expect(mocks.resolveSessionTransportContext).toHaveBeenCalledWith({
      credentials: expect.any(Object),
      idOrPrefix: 'sess_1',
    });
  });

  it('lists agent session modes and config options from the shared option registry', async () => {
    const deps = createCliActionInventoryDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { path: '/repo', metadata: {} },
    });

    const modes = await deps.agentsSessionModesList?.({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      limit: 200,
    }) as { source?: string; items?: readonly { id?: string }[] };
    const configOptions = await deps.agentsConfigOptionsList?.({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      limit: 200,
    }) as { source?: string; items?: readonly { id?: string }[] };

    expect(modes.source).toBeTruthy();
    expect(Array.isArray(modes.items)).toBe(true);
    expect(configOptions.source).toBeTruthy();
    expect(Array.isArray(configOptions.items)).toBe(true);
    expect(JSON.stringify(configOptions)).not.toMatch(/token|secret|password/i);
  });

  it('lists spawn target paths, machines, and servers from canonical session and daemon owners', async () => {
    mocks.listSessions.mockResolvedValueOnce({
      sessions: [
        { id: 'sess-a', path: '/repo/a', host: 'host-a', activeAt: 30 },
        { id: 'sess-a-older', path: '/repo/a', host: 'host-a', activeAt: 20 },
        { id: 'sess-b', path: '/repo/b', host: 'host-b', activeAt: 10 },
        { id: 'sess-missing-path', host: 'host-c', activeAt: 5 },
      ],
      nextCursor: null,
    });
    mocks.listDaemonStatusesForAllKnownServers.mockResolvedValue([
      {
        serverId: 'cloud',
        name: 'Cloud',
        serverUrl: 'https://api.example.test',
        comparableKey: 'api.example.test',
        daemonStatePath: '/state/cloud.json',
        auth: {
          authenticated: true,
          needsAuth: false,
          machineRegistered: true,
          machineId: 'machine-cloud',
          accountId: 'acct-1',
        },
        drift: { activeComparableKey: 'api.example.test', matchesActiveRelay: true },
        service: { installed: true, running: true },
        daemon: { pid: 123, httpPort: 456, running: true, staleStateFile: false },
      },
      {
        serverId: 'local',
        name: 'Local',
        serverUrl: 'http://127.0.0.1:3000',
        comparableKey: '127.0.0.1:3000',
        daemonStatePath: '/state/local.json',
        auth: {
          authenticated: false,
          needsAuth: true,
          machineRegistered: false,
          machineId: null,
          accountId: null,
        },
        drift: { activeComparableKey: 'api.example.test', matchesActiveRelay: false },
        service: { installed: false, running: false },
        daemon: { pid: null, httpPort: null, running: false, staleStateFile: false },
      },
    ]);

    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const paths = await deps.pathsListRecent({ limit: 2 }) as { items: readonly unknown[] };
    const machines = await deps.machinesList({ limit: 10 }) as { items: readonly unknown[] };
    const servers = await deps.serversList({ limit: 10 }) as { items: readonly unknown[] };

    expect(paths.items).toEqual([
      {
        value: '/repo/a',
        label: '/repo/a',
        path: '/repo/a',
        host: 'host-a',
        sessionId: 'sess-a',
        activeAt: 30,
      },
      {
        value: '/repo/b',
        label: '/repo/b',
        path: '/repo/b',
        host: 'host-b',
        sessionId: 'sess-b',
        activeAt: 10,
      },
    ]);
    expect(machines.items).toEqual([
      {
        value: 'machine-cloud',
        label: 'machine-cloud',
        machineId: 'machine-cloud',
        serverId: 'cloud',
        serverName: 'Cloud',
        authenticated: true,
        machineRegistered: true,
        daemonRunning: true,
      },
    ]);
    expect(servers.items).toEqual([
      {
        value: 'cloud',
        label: 'Cloud',
        serverId: 'cloud',
        serverUrl: 'https://api.example.test',
        authenticated: true,
        needsAuth: false,
        machineId: 'machine-cloud',
        daemonRunning: true,
      },
      {
        value: 'local',
        label: 'Local',
        serverId: 'local',
        serverUrl: 'http://127.0.0.1:3000',
        authenticated: false,
        needsAuth: true,
        machineId: null,
        daemonRunning: false,
      },
    ]);
    expect(JSON.stringify({ paths, machines, servers })).not.toContain('acct-1');
  });

  it('lists spawn profiles from account settings without profile env values or secret binding ids', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        profiles: [
          {
            id: 'custom-openai',
            name: 'Custom OpenAI',
            description: 'Custom profile',
            environmentVariables: [{ name: 'OPENAI_API_KEY', value: 'SECRET_VALUE', isSecret: true }],
            envVarRequirements: [
              { name: 'OPENAI_API_KEY', kind: 'secret', required: true },
              { name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
            ],
            compatibilityByTargetKey: { 'agent:codex': true },
            defaultEnabled: true,
            isBuiltIn: false,
          },
        ],
        secretBindingsByProfileId: {
          'custom-openai': { OPENAI_API_KEY: 'secret_binding_id' },
        },
      },
      settingsVersion: 2,
      loadedAtMs: 1,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const result = await deps.sessionsSpawnProfilesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.items?.find((item) => item.id === 'custom-openai')).toMatchObject({
      value: 'custom-openai',
      label: 'Custom OpenAI',
      id: 'custom-openai',
      name: 'Custom OpenAI',
      isBuiltIn: false,
      supportedAgentIds: expect.arrayContaining(['codex']),
      requiredSecretEnvVarNames: ['OPENAI_API_KEY'],
      requiredConfigEnvVarNames: ['GOOGLE_CLOUD_PROJECT'],
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(result)).not.toContain('secret_binding_id');
  });

  it('reads current account settings for spawn profile inventory without recreating deps', async () => {
    mocks.bootstrapAccountSettingsContext
      .mockResolvedValueOnce({
        settings: {
          profiles: [
            {
              id: 'old-profile',
              name: 'Old profile',
              compatibilityByTargetKey: { 'agent:codex': true },
              defaultEnabled: true,
              isBuiltIn: false,
            },
          ],
        },
        settingsVersion: 1,
        loadedAtMs: 1,
      })
      .mockResolvedValueOnce({
        settings: {
          profiles: [
            {
              id: 'new-profile',
              name: 'New profile',
              compatibilityByTargetKey: { 'agent:codex': true },
              defaultEnabled: true,
              isBuiltIn: false,
            },
          ],
        },
        settingsVersion: 2,
        loadedAtMs: 2,
      });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionsSpawnProfilesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    });
    const result = await deps.sessionsSpawnProfilesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(mocks.bootstrapAccountSettingsContext).toHaveBeenCalledTimes(2);
    expect(result?.items?.map((item) => item.id)).toContain('new-profile');
    expect(result?.items?.map((item) => item.id)).not.toContain('old-profile');
  });

  it('lists spawn connected-service options from account profile projection without credential material', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        connectedServicesProfileLabelByKey: { 'openai-codex/work': 'Work OpenAI' },
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      },
      settingsVersion: 2,
      loadedAtMs: 1,
    });
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        id: 'acct_1',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [
              {
                profileId: 'work',
                status: 'connected',
                kind: 'oauth',
                providerEmail: 'dev@example.com',
                providerAccountId: 'provider-account-id',
              },
              {
                profileId: 'token-profile',
                status: 'connected',
                kind: 'token',
                providerEmail: 'token@example.com',
              },
            ],
            groups: [
              {
                groupId: 'group_1',
                displayName: 'Work group',
                activeProfileId: 'work',
                memberProfileIds: ['work'],
                generation: 3,
              },
            ],
          },
        ],
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const result = await deps.sessionsSpawnConnectedServicesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.items).toEqual([
      expect.objectContaining({
        value: 'openai-codex',
        label: 'openai-codex',
        serviceId: 'openai-codex',
        profiles: [
          {
            profileId: 'work',
            status: 'connected',
            kind: 'oauth',
            providerEmail: 'dev@example.com',
            label: 'Work OpenAI',
          },
          {
            profileId: 'token-profile',
            status: 'unsupported_kind',
            kind: 'token',
            providerEmail: 'token@example.com',
            label: null,
          },
        ],
        accountGroups: [
          {
            groupId: 'group_1',
            label: 'Work group',
            activeProfileId: 'work',
            memberProfileIds: ['work'],
            generation: 3,
            enabledMemberCount: 1,
            autoSwitch: false,
            status: 'ready',
          },
        ],
        defaultProfileId: 'work',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('provider-account-id');
    expect(JSON.stringify(result)).not.toMatch(/token_value|secret|ciphertext/i);
  });

  it('fails connected-service discovery closed when connected-services feature gates are disabled', async () => {
    mocks.resolveCliFeatureDecisionForServer.mockImplementation(async (params?: unknown) => ({
      decision: {
        state: (params as { featureId?: unknown } | undefined)?.featureId === 'connectedServices'
          ? 'disabled'
          : 'enabled',
      },
    }));
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        id: 'acct_1',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            groups: [{ groupId: 'group_1', displayName: 'Work group', activeProfileId: 'work', memberProfileIds: ['work'] }],
          },
        ],
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionsSpawnConnectedServicesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    })).resolves.toEqual({ items: [] });
    expect(mocks.axiosGet).not.toHaveBeenCalled();
  });

  it('omits connected-service account groups when account-group feature gate is disabled', async () => {
    mocks.resolveCliFeatureDecisionForServer.mockImplementation(async (params?: unknown) => ({
      decision: {
        state: (params as { featureId?: unknown } | undefined)?.featureId === 'connectedServices.accountGroups'
          ? 'disabled'
          : 'enabled',
      },
    }));
    mocks.axiosGet.mockResolvedValue({
      status: 200,
      data: {
        id: 'acct_1',
        connectedServicesV2: [
          {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            groups: [{ groupId: 'group_1', displayName: 'Work group', activeProfileId: 'work', memberProfileIds: ['work'] }],
          },
        ],
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const result = await deps.sessionsSpawnConnectedServicesList?.({
      agentId: 'codex',
      backendTargetKey: 'agent:codex',
      limit: 200,
    }) as { items?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.items?.[0]).toMatchObject({
      serviceId: 'openai-codex',
      accountGroups: [],
    });
  });

  it('previews spawn MCP servers through the daemon preview owner without secret refs', async () => {
    mocks.bootstrapAccountSettingsContext.mockResolvedValue({
      settings: {
        mcpServersSettingsV1: {
          v: 1,
          strictMode: false,
          servers: [
            {
              id: 'srv_linear',
              name: 'linear',
              title: 'Linear',
              transport: 'stdio',
              stdio: { command: 'linear-mcp', args: [] },
              env: { LINEAR_API_KEY: { t: 'savedSecret', secretId: 'saved_secret_linear' } },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          bindings: [
            {
              id: 'bind_linear',
              serverId: 'srv_linear',
              enabled: true,
              target: { t: 'allMachines' },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
      settingsVersion: 2,
      loadedAtMs: 1,
    });
    mocks.detectProviderMcpServers.mockResolvedValue({
      servers: [
        {
          provider: 'claude',
          name: 'playwright',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['@playwright/mcp'] },
          envKeys: ['PLAYWRIGHT_TOKEN'],
          enabled: true,
          source: { kind: 'project', path: '/repo/.claude/settings.local.json' },
        },
      ],
      warnings: [],
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        path: '/repo',
        machineId: 'machine-local',
        metadata: { path: '/repo', machineId: 'machine-local' },
      },
    });

    const result = await deps.sessionsSpawnMcpServersPreview?.({
      agentId: 'claude',
      backendTargetKey: 'agent:claude',
      machineId: 'machine-local',
      path: '/repo',
      limit: 200,
    }) as { ok?: boolean; managed?: readonly Record<string, unknown>[]; detected?: readonly Record<string, unknown>[] } | undefined;

    expect(result?.ok).toBe(true);
    expect(result?.managed?.[0]).toMatchObject({
      key: 'managed:srv_linear',
      serverId: 'srv_linear',
      name: 'linear',
      title: 'Linear',
      authMode: 'savedSecret',
      selected: true,
      sourceKind: 'managed',
    });
    expect(result?.detected?.[0]).toMatchObject({
      key: 'detected:claude:playwright',
      name: 'playwright',
      authMode: 'unknown',
      envKeyCount: 1,
      sourceKind: 'detected',
      scopeKind: 'providerProject',
    });
    expect(mocks.detectProviderMcpServers).toHaveBeenCalledWith({
      directory: '/repo',
      providers: undefined,
      env: process.env,
    });
    expect(JSON.stringify(result)).not.toContain('saved_secret_linear');
    expect(JSON.stringify(result)).not.toContain('LINEAR_API_KEY');
    expect(JSON.stringify(result)).not.toContain('PLAYWRIGHT_TOKEN');
  });

  it('rejects invalid message permission overrides before sending to the service', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 10,
        },
      },
    });

    const result = await deps.sessionSendMessage({
      sessionId: 'sess_2',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      permissionModeOverride: 'not-a-mode',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('preserves exact nonblank opaque model override bytes through the CLI service adapter', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionSendMessage({
      sessionId: 'sess_1',
      message: 'hello',
      requestedAction: { v: 1, kind: 'steer_if_active' },
      modelOverride: ' model-a\t',
    });

    expect(mocks.sendSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: ' model-a\t',
    }));
  });

  it('wires transcript and events actions to the canonical services', async () => {
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionTranscriptGet?.({
      sessionId: 'sess_1',
      limit: 2,
      cursor: '10',
      roles: ['assistant'],
      includeTools: true,
      maxCharsPerMessage: 100,
    });
    await deps.sessionEventsGet?.({
      sessionId: 'sess_1',
      limit: 3,
      roles: ['event'],
      kinds: ['tool-call'],
      includeRaw: true,
      maxPayloadChars: 256,
    });

    expect(mocks.getSessionTranscript).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
      limit: 2,
      cursor: '10',
      roles: ['assistant'],
      includeTools: true,
      maxCharsPerMessage: 100,
    });
    expect(mocks.getSessionEvents).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess_1',
      limit: 3,
      roles: ['event'],
      kinds: ['tool-call'],
      includeRaw: true,
      maxPayloadChars: 256,
    });
  });

  it('forwards session list preview and row shape options to the list service', async () => {
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionList({
      limit: 10,
      cursor: 'cursor-1',
      includeLastMessagePreview: true,
      includeRows: true,
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
    });

    expect(mocks.listSessions).toHaveBeenCalledWith({
      credentials,
      activeOnly: true,
      archivedOnly: false,
      includeSystem: true,
      resumableOnly: true,
      includeLastMessagePreview: true,
      includeRows: true,
      limit: 10,
      cursor: 'cursor-1',
    });
  });

  it('calls native session goal RPC instead of sending goal text', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({ sessionId: 'sess_1', objective: 'Ship native goals' })).resolves.toEqual({
      ok: true,
    });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'plain',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`,
      request: { objective: 'Ship native goals' },
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('calls live terminal composer clear RPC for session terminal composer clear actions', async () => {
    mocks.callSessionRpc.mockResolvedValueOnce({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    } as never);
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionTerminalComposerClear?.({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    })).resolves.toEqual({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'plain',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR}`,
      request: {
        sessionId: 'sess_1',
        expectedStateAtMs: 1_700_000_000_000,
      },
    }));
  });

  it('delegates inactive local goal mutations to the provider goal control adapter', async () => {
    const providerSetGoal = vi.fn(async (_params: unknown) => ({ ok: true, workState: { v: 1, items: [], primaryItemId: null, updatedAt: 1 } }));
    mocks.getSessionGoalControlAdapter.mockResolvedValueOnce({
      setGoal: providerSetGoal,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({
      sessionId: 'sess_inactive',
      objective: 'Ship native goals',
      status: 'paused',
      tokenBudget: null,
    })).resolves.toEqual({
      ok: true,
      workState: { v: 1, items: [], primaryItemId: null, updatedAt: 1 },
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionGoalControlAdapter).toHaveBeenCalledWith('codex');
    expect(providerSetGoal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      request: {
        objective: 'Ship native goals',
        status: 'paused',
        tokenBudget: null,
      },
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
      currentMachineId: 'machine-local',
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('omits objective from status-only inactive goal mutations', async () => {
    const providerSetGoal = vi.fn(async (_params: { request: Record<string, unknown> }) => ({ ok: true }));
    mocks.getSessionGoalControlAdapter.mockResolvedValueOnce({
      setGoal: providerSetGoal,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionGoalSet?.({
      sessionId: 'sess_inactive',
      status: 'paused',
    })).resolves.toEqual({ ok: true });

    expect(providerSetGoal).toHaveBeenCalledWith(expect.objectContaining({
      request: { status: 'paused' },
    }));
    const request = providerSetGoal.mock.calls[0]?.[0].request;
    expect(Object.prototype.hasOwnProperty.call(request, 'objective')).toBe(false);
  });

  it('calls native catalog RPCs for vendor plugins and skills', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionVendorPluginCatalogList?.({ sessionId: 'sess_1' });
    await deps.sessionSkillCatalogList?.({ sessionId: 'sess_1' });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST}`,
      request: {},
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST}`,
      request: {},
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('delegates inactive local catalog requests to the provider catalog control adapter', async () => {
    const listVendorPlugins = vi.fn(async (_params: unknown) => ({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    }));
    const listSkills = vi.fn(async (_params: unknown) => ({
      skills: [{ name: 'review', path: '/skills/review/SKILL.md', origin: 'codex_native' }],
    }));
    mocks.getSessionCatalogControlAdapter.mockResolvedValue({
      listVendorPlugins,
      listSkills,
    });
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionVendorPluginCatalogList?.({ sessionId: 'sess_inactive', cwd: '/repo' })).resolves.toEqual({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    await expect(deps.sessionSkillCatalogList?.({ sessionId: 'sess_inactive', cwd: '/repo' })).resolves.toEqual({
      skills: [{ name: 'review', path: '/skills/review/SKILL.md', origin: 'codex_native' }],
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionCatalogControlAdapter).toHaveBeenCalledWith('codex');
    expect(listVendorPlugins).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      cwd: '/repo',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    }));
    expect(listSkills).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      cwd: '/repo',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    }));
  });

  it('calls native inline review RPCs without sending user prompts', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const input = ReviewStartInputSchema.parse({
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    });
    await expect(deps.reviewStartInline?.({
      sessionId: 'sess_1',
      engineId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Check correctness.',
      input,
    })).resolves.toEqual({ ok: true });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess_1',
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE}`,
      request: input,
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('rejects native inline review permission above the caller permission before RPC dispatch', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    const input = ReviewStartInputSchema.parse({
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
      permissionMode: 'workspace_write',
    });
    await expect(deps.reviewStartInline?.({
      sessionId: 'sess_1',
      engineId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Check correctness.',
      input,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
      details: {
        requestedMode: 'safe-yolo',
        requestedOrdinal: 2,
        callerMode: 'default',
        callerOrdinal: 1,
      },
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('uses the forwarded session-agent caller permission mode for spawn non-escalation', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      callerSurface: 'session_agent',
      callerPermissionMode: 'bypassPermissions',
      permissionMode: 'bypassPermissions',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'spawned_1',
    });

    expect(mocks.createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      permissionMode: 'bypassPermissions',
    }));
  });

  it('calls native usage-limit recovery RPCs', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      remember: true,
    });
    await deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_1',
      issueFingerprint: null,
    });
    await deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1' });

    // No explicit per-operation resume prompt mode was requested, so none may be
    // forwarded: downstream owners must resolve the precedence tiers themselves
    // (stored intent > account setting > group policy > provider config > default).
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: 'usage-limit:sess_1:reset',
        remember: true,
      },
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL}`,
      request: {
        sessionId: 'sess_1',
        issueFingerprint: null,
      },
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      request: { sessionId: 'sess_1' },
    }));
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('forwards an explicit custom resume prompt mode unchanged for usage-limit controls', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      resumePromptMode: 'custom',
    });
    await deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1', resumePromptMode: 'custom' });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`,
      request: expect.objectContaining({ resumePromptMode: 'custom' }),
    }));
    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      request: expect.objectContaining({ resumePromptMode: 'custom' }),
    }));
  });

  it('routes active temporary-throttle retry-now through the daemon scheduler callback', async () => {
    const retryTemporaryThrottleNow = vi.fn(async () => ({ status: 'resumed' }));
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'provider_temporary_throttle',
          source: 'provider_status_error',
          provider: 'codex',
          providerTurnId: 'turn-throttle',
          occurredAt: 1_700_000_000_000,
          sanitizedPreview: 'Provider is temporarily limiting requests',
          temporaryThrottle: {
            v: 1,
            retryAfterMs: 30_000,
            recoverability: 'retry',
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      retryTemporaryThrottleNow,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_1' })).resolves.toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_1',
    });

    expect(retryTemporaryThrottleNow).toHaveBeenCalledWith({ sessionId: 'sess_1' });
    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionUsageLimitRecoveryControlAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ['live control succeeds', {
      ok: true,
      status: 'ready',
      sessionId: 'sess_stale',
    }, false],
    ['app-server control is unavailable', {
      ok: false,
      errorCode: 'codex_app_server_control_unavailable',
      error: 'codex_app_server_control_unavailable',
    }, true],
    ['the stale Session RPC is unreachable', {
      ok: false,
      errorCode: 'session_rpc_failed',
      error: 'session_rpc_failed',
    }, true],
  ])('handles a stale active Codex session when %s', async (_scenario, liveResult, shouldSpawn) => {
    mocks.callSessionRpc.mockResolvedValueOnce(liveResult);
    mocks.callMachineRpc.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_stale' });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_stale',
      rawSession: {
        id: 'sess_stale',
        active: true,
        latestTurnStatus: 'failed',
        path: '/repo',
        machineId: 'machine-local',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-usage-limited',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
          },
        },
        metadata: {
          machineId: 'machine-local',
          path: '/repo',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'codex-thread-persisted',
            },
          },
          codexSessionId: 'codex-thread-persisted',
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const credentials = createCredentials();
    const deps = createCliActionDeps({
      token: 'token',
      credentials,
      sessionId: 'sess_current',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_stale', provider: 'codex' })).resolves.toEqual({
      ok: true,
      status: shouldSpawn ? 'resumed' : 'ready',
      sessionId: 'sess_stale',
    });

    expect(mocks.callSessionRpc).toHaveBeenCalledTimes(1);
    if (!shouldSpawn) {
      expect(mocks.callMachineRpc).not.toHaveBeenCalled();
      return;
    }
    expect(mocks.callMachineRpc).toHaveBeenCalledTimes(1);
    expect(mocks.callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-local',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: expect.objectContaining({
        type: 'resume-session',
        sessionId: 'sess_stale',
        directory: '/repo',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'codex-thread-persisted',
          },
        },
      }),
    });
    const machineCall = mocks.callMachineRpc.mock.calls[0]?.[0] as { request?: unknown } | undefined;
    const spawnRequest = machineCall?.request;
    expect(spawnRequest).not.toHaveProperty('message');
    expect(spawnRequest).not.toHaveProperty('prompt');
    expect(mocks.getSessionUsageLimitRecoveryControlAdapter).not.toHaveBeenCalled();
  });

  it('routes inactive local usage-limit controls without re-entering live session RPC', async () => {
    const checkNow = vi.fn(async (_params: unknown) => ({ ok: true, status: 'ready' }));
    // The adapter is also consulted for the provider-config resume-prompt tier,
    // so it must resolve consistently across the whole test.
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockResolvedValue({
      checkNow,
    });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage-limit:sess_inactive:reset',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            resetAtMs: 2,
            nextCheckAtMs: 2,
            attemptCount: 0,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-1',
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
    })).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_inactive',
    });
    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_inactive',
    });
    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_inactive' })).resolves.toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess_inactive',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.getSessionUsageLimitRecoveryControlAdapter).toHaveBeenCalledWith('codex');
    expect(mocks.updateSessionMetadataWithRetry).toHaveBeenCalledTimes(2);
    expect(checkNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      cwd: '/repo',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
      currentMachineId: 'machine-local',
    }));
  });

  it('passes inactive ready usage-limit recovery through the daemon resume callback', async () => {
    const resumeInactiveSessionWhenReady = vi.fn(async () => true);
    const checkNow = vi.fn(async (_params: unknown) => ({ ok: true, status: 'ready' }));
    mocks.getSessionUsageLimitRecoveryControlAdapter.mockResolvedValueOnce({ checkNow });
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      resumeInactiveSessionWhenUsageLimitReady: resumeInactiveSessionWhenReady,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess_inactive' })).resolves.toEqual({
      ok: true,
      status: 'resumed',
      sessionId: 'sess_inactive',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    });

    expect(resumeInactiveSessionWhenReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      metadata: expect.objectContaining({ machineId: 'machine-local' }),
    }));
  });

  it('routes usage-limit switch-account controls through daemon runtime-auth recovery instead of live check-now', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_group',
      rawSession: {
        active: true,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'switch_account',
            action: { kind: 'settings' },
            connectedService: {
              serviceId: 'openai-codex',
              profileId: 'primary',
              groupId: 'codex-main',
            },
          },
        },
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'codex' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_group',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_group',
      provider: 'codex',
      resumePromptMode: 'custom',
    })).resolves.toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'sess_group',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.notifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
      sessionId: 'sess_group',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        quotaScope: 'account',
        action: null,
        limitCategory: 'usage_limit',
      }),
      resumePromptMode: 'custom',
    });
  });

  it('uses the injected runtime-auth notifier for daemon machine usage-limit switch-account controls', async () => {
    const notifyConnectedServiceRuntimeAuthFailure = vi.fn(async () => ({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
      },
    }));
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_group',
      rawSession: {
        active: false,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'switch_account',
            connectedService: {
              serviceId: 'openai-codex',
              profileId: 'primary',
              groupId: 'codex-main',
            },
          },
        },
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'codex' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_group',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      notifyConnectedServiceRuntimeAuthFailure,
    });

    await expect(deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_group',
      provider: 'codex',
    })).resolves.toEqual({
      ok: true,
      status: 'switch_applied',
      sessionId: 'sess_group',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(notifyConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith({
      sessionId: 'sess_group',
      switchesThisTurn: 0,
      classification: expect.objectContaining({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
      }),
    });
    expect(mocks.notifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
  });

  it('schedules an inactive usage-limit recovery check when wait-resume is armed', async () => {
    const scheduleInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'claude',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: 1_700_000_060_000,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
          },
        },
        metadata: {
          machineId: 'machine-local',
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      scheduleInactiveSessionUsageLimitRecoveryCheck,
    } as Parameters<typeof createCliActionDeps>[0] & Readonly<{
      scheduleInactiveSessionUsageLimitRecoveryCheck: ReturnType<typeof vi.fn>;
    }>);

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
    })).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_inactive',
    });

    expect(scheduleInactiveSessionUsageLimitRecoveryCheck).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_inactive',
      recovery: expect.objectContaining({
        status: 'waiting',
        nextCheckAtMs: 1_700_000_060_000,
      }),
      runCheckNow: expect.any(Function),
    }));
  });

  it('clears an inactive usage-limit recovery check when wait-resume is cancelled', async () => {
    const cancelInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage-limit:sess_inactive:reset',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            resetAtMs: 2,
            nextCheckAtMs: 2,
            attemptCount: 0,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
          },
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      cancelInactiveSessionUsageLimitRecoveryCheck,
    } as Parameters<typeof createCliActionDeps>[0] & Readonly<{
      cancelInactiveSessionUsageLimitRecoveryCheck: ReturnType<typeof vi.fn>;
    }>);

    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_inactive',
    });

    expect(cancelInactiveSessionUsageLimitRecoveryCheck).toHaveBeenCalledWith({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  // QAE-1: the routed daemon-side cancel must clear the daemon runtime-auth
  // recovery store too, not only the inactive usage-limit check — an armed
  // runtime-auth waiting intent resumes the session involuntarily at reset.
  it('cancels the daemon runtime-auth recovery intent when wait-resume is cancelled', async () => {
    const cancelConnectedServiceRuntimeAuthRecovery = vi.fn();
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_inactive',
      rawSession: {
        active: false,
        path: '/repo',
        machineId: 'machine-local',
        metadata: {
          machineId: 'machine-local',
          sessionUsageLimitRecoveryV1: {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage-limit:sess_inactive:reset',
            armedAtMs: 1,
            runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
            resetAtMs: 2,
            nextCheckAtMs: 2,
            attemptCount: 0,
            maxAttempts: 3,
            lastProbeError: null,
            selectedAuth: { kind: 'native', serviceId: 'claude-subscription' },
          },
          agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_inactive',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
      cancelConnectedServiceRuntimeAuthRecovery,
    } as Parameters<typeof createCliActionDeps>[0] & Readonly<{
      cancelConnectedServiceRuntimeAuthRecovery: ReturnType<typeof vi.fn>;
    }>);

    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_inactive',
      issueFingerprint: 'usage-limit:sess_inactive:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_inactive',
    });

    expect(cancelConnectedServiceRuntimeAuthRecovery).toHaveBeenCalledWith({
      sessionId: 'sess_inactive',
      attemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('fails usage-limit recovery actions closed when the feature is disabled for the target server', async () => {
    mocks.resolveCliFeatureDecisionForServer.mockResolvedValue({ decision: { state: 'disabled' } });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      remember: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_1',
      issueFingerprint: null,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_1',
      provider: 'codex',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
    expect(mocks.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('returns schema-valid usage-limit recovery errors when credentials are unavailable', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess_1',
      issueFingerprint: null,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });
    expect(parseUsageLimitResult(await deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess_1',
      provider: 'codex',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'not_authenticated',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit permission response for a request already completed in session state', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {},
          completedRequests: {
            perm_done_1: { kind: 'permission', tool: 'Write', status: 'approved', createdAt: 1 },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess_1',
      requestId: 'perm_done_1',
      decision: 'allow',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit user-action answer for a request already completed in session state', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {},
          completedRequests: {
            ask_done_1: { kind: 'user_action', tool: 'AskUserQuestion', status: 'approved', createdAt: 1 },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUserActionAnswer?.({
      sessionId: 'sess_1',
      requestId: 'ask_done_1',
      decision: 'approve',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit permission response that targets a pending user-action request', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {
            ask_pending_1: { kind: 'user_action', tool: 'AskUserQuestion', createdAt: 1 },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess_1',
      requestId: 'ask_pending_1',
      decision: 'allow',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('rejects an explicit user-action answer that targets a pending permission request', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {
            perm_pending_1: { kind: 'permission', tool: 'Write', createdAt: 1 },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionUserActionAnswer?.({
      sessionId: 'sess_1',
      requestId: 'perm_pending_1',
      decision: 'approve',
      answers: [{ question: 'Continue?', values: ['Yes'] }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess_1',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('forwards an explicit permission response for a matching pending permission request', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true as const,
      sessionId: 'sess_1',
      rawSession: {
        active: true,
        agentState: {
          requests: {
            perm_pending_ok_1: { kind: 'permission', tool: 'Write', createdAt: 1 },
          },
          completedRequests: {},
        },
      },
      ctx: {
        encryptionKey: new Uint8Array(32).fill(3),
        encryptionVariant: 'legacy' as const,
      },
      mode: 'plain' as const,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess_1',
      requestId: 'perm_pending_ok_1',
      decision: 'allow',
    })).resolves.toEqual({ ok: true });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'sess_1:permission',
      request: { id: 'perm_pending_ok_1', approved: true },
    }));
  });

  it('returns schema-valid usage-limit recovery errors when the session transport cannot be resolved', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: false as const,
      code: 'session_not_found',
      candidates: ['sess_a', 'sess_b'],
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    expect(parseUsageLimitResult(await deps.sessionUsageLimitCheckNow?.({
      sessionId: 'missing',
    }))).toEqual({
      ok: false,
      status: 'not_found',
      sessionId: 'missing',
      errorCode: 'session_not_found',
    });

    expect(mocks.callSessionRpc).not.toHaveBeenCalled();
  });

  it('lets the active session runtime decide inline review provider support', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: createCredentials(),
      sessionId: 'sess_1',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
      rawSession: { metadata: {} },
    });

    const input = ReviewStartInputSchema.parse({
      engineIds: ['claude'],
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    });
    await expect(deps.reviewStartInline?.({
      sessionId: 'sess_1',
      engineId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: '',
      input,
    })).resolves.toEqual({ ok: true });

    expect(mocks.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `sess_1:${SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE}`,
      request: input,
    }));
  });
});
