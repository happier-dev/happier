import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionTakeoverPersistResponseSchema,
  ExternalSessionTakeoverResponseSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const {
  readCredentialsMock,
  fetchSessionByIdMock,
  dispatchActivityNotificationAsyncMock,
  getActiveAccountSettingsSnapshotMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(),
  fetchSessionByIdMock: vi.fn(),
  dispatchActivityNotificationAsyncMock: vi.fn(async () => ({
    attemptedChannels: 1,
    deliveredChannels: 1,
  })),
  getActiveAccountSettingsSnapshotMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    publicReleaseRing: 'stable',
    isDaemonProcess: false,
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<
    typeof import('@/session/transport/http/sessionsHttp')
  >('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: fetchSessionByIdMock,
  };
});

vi.mock('@/notifications/activity/dispatchActivityNotification', () => ({
  dispatchActivityNotificationAsync: dispatchActivityNotificationAsyncMock,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshotMock,
}));

import { registerMachineExternalSessionsRpcHandlers } from '../rpcHandlers.externalSessions';

type TestRpcHandler = (params: unknown) => Promise<unknown>;

function createRpcHandlerManager(): Readonly<{
  handlers: Map<string, TestRpcHandler>;
  manager: Readonly<{
    registerHandler(method: string, handler: TestRpcHandler): void;
  }>;
}> {
  const handlers = new Map<string, TestRpcHandler>();
  return {
    handlers,
    manager: {
      registerHandler: (method, handler) => {
        handlers.set(method, handler);
      },
    },
  };
}

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('registerMachineExternalSessionsRpcHandlers', () => {
  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    const contributes = createResolvedContributionRegistry(
      resolveBuiltInContributions(),
    );
    const externalSessionAgentIds = new Set(['claude', 'codex', 'opencode']);
    const pluginIds = contributes.agents
      .filter((agent) => externalSessionAgentIds.has(agent.id))
      .map((agent) => agent.pluginId)
      .filter((pluginId): pluginId is string => typeof pluginId === 'string');
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () =>
        await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir: '/tmp/happier-test-home',
          contributes,
          pluginIds,
        }),
    });
    for (const agentId of externalSessionAgentIds) {
      const surfaces = await resolveBackendExecutionSurfaces(agentId);
      if (!surfaces.externalSession) {
        throw new Error(
          `Expected authoritative ${agentId} external-session execution surface`,
        );
      }
    }
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    getActiveAccountSettingsSnapshotMock.mockReturnValue({
      source: 'active',
      settings: {
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: true,
          ready: true,
          permissionRequest: false,
        },
      },
      settingsSecretsReadKeys: [],
    });
  });

  it.each([
    {
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
      schema: ExternalSessionTakeoverResponseSchema,
    },
    {
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      schema: ExternalSessionTakeoverPersistResponseSchema,
    },
  ])(
    'fails the retained legacy takeover route $method closed before any effect',
    async ({ method, schema }) => {
      const { handlers, manager } = createRpcHandlerManager();
      const spawnSession = vi.fn();
      const stopSession = vi.fn();
      registerMachineExternalSessionsRpcHandlers({
        rpcHandlerManager: manager as never,
        spawnSession,
        stopSession,
      });

      const handler = handlers.get(method);
      expect(handler).toBeDefined();

      const response = schema.parse(await handler!({
        machineId: 'machine-1',
        sessionId: 'linked-session-1',
      }));
      expect(response).toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'upgrade_required',
      });
      expect(readCredentialsMock).not.toHaveBeenCalled();
      expect(fetchSessionByIdMock).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(stopSession).not.toHaveBeenCalled();
    },
  );

  it('dispatches transcript.page through the current Claude contribution', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'happier-externalSessions-rpc-page-'),
    );
    const configDir = join(root, '.claude');
    const sessionFile = join(
      configDir,
      'projects',
      'proj-a',
      'sess-1.jsonl',
    );
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(
      sessionFile,
      [
        jsonlLine({
          type: 'user',
          uuid: 'u1',
          message: { content: 'hello' },
        }),
        jsonlLine({
          type: 'assistant',
          uuid: 'a1',
          message: { model: 'm', content: [] },
        }),
      ].join(''),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const { handlers, manager } = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: manager as never,
    });

    const handler = handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
    );
    expect(handler).toBeDefined();

    const response = ExternalSessionTranscriptPageResponseSchema.parse(
      await handler!({
        machineId: 'm1',
        agentId: 'claude',
        remoteSessionId: 'sess-1',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
        direction: 'older',
        maxItems: 10,
        maxBytes: 1024 * 1024,
      }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.items.length).toBeGreaterThanOrEqual(2);
    expect(response.items[0]?.raw.role).toBe('user');
    expect(response.tailCursor).toBeTruthy();
  });

  it('rejects Agent/source mismatches as invalid_request', async () => {
    const { handlers, manager } = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: manager as never,
    });

    const handler = handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
    );
    expect(handler).toBeDefined();

    const response = ExternalSessionsCandidatesListResponseSchema.parse(
      await handler!({
        machineId: 'm1',
        agentId: 'codex',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp',
          projectId: null,
        },
        limit: 10,
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      errorCode: 'invalid_request',
    });
  });

  it('rejects Claude source overrides outside the configured config dir', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/safe/.claude');

    const { handlers, manager } = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: manager as never,
    });

    const handler = handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
    );
    expect(handler).toBeDefined();

    const response = ExternalSessionsCandidatesListResponseSchema.parse(
      await handler!({
        machineId: 'm1',
        agentId: 'claude',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/rogue-claude',
          projectId: null,
        },
        limit: 10,
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.errorCode).toBe('invalid_request');
    expect(response.error).toContain('source');
  });

  it('reports persisted takeover unavailable when a linked session cannot resume safely', async () => {
    vi.stubEnv(
      'HAPPIER_CLAUDE_CONFIG_DIR',
      '/tmp/claude-direct-status',
    );
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_direct_status',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        claudeSessionId: 'sess-claude-status',
        externalSessionV1: {
          v: 1,
          agentId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-status',
          source: {
            kind: 'claudeConfig',
            configDir: '/tmp/claude-direct-status',
            projectId: 'missing-project',
          },
          linkedAtMs: Date.now(),
        },
      }),
    });

    const { handlers, manager } = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: manager as never,
    });

    const handler = handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
    );
    expect(handler).toBeDefined();

    const response = ExternalSessionStatusGetResponseSchema.parse(
      await handler!({
        machineId: 'm1',
        sessionId: 'sess_happy_direct_status',
        agentId: 'claude',
        remoteSessionId: 'sess-claude-status',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude-direct-status',
          projectId: 'missing-project',
        },
      }),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.canTakeOverPersist).toBe(false);
  });

  it('rejects OpenCode baseUrl overrides outside the configured server url', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', 'http://127.0.0.1:4010');

    const { handlers, manager } = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: manager as never,
    });

    const handler = handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
    );
    expect(handler).toBeDefined();

    const response = ExternalSessionTranscriptReadAfterResponseSchema.parse(
      await handler!({
        machineId: 'm1',
        agentId: 'opencode',
        remoteSessionId: 'remote_123',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'http://127.0.0.1:4999',
          directory: null,
        },
        cursor: 'tail',
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.errorCode).toBe('invalid_request');
    expect(response.error).toContain('source');
  });
});
