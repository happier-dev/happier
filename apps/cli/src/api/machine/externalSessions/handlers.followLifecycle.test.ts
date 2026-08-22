import { appendFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionTranscriptInvalidationV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';

const {
  readCredentialsMock,
  fetchSessionByIdMock,
  commitSessionStoredMessageMock,
  updateSessionMetadataWithRetryMock,
  dispatchActivityNotificationAsyncMock,
  getActiveAccountSettingsSnapshotMock,
  resolveTranscriptRefreshBindingMock,
  fetchAccountEncryptionCurrentnessMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(),
  fetchSessionByIdMock: vi.fn(),
  commitSessionStoredMessageMock: vi.fn(),
  updateSessionMetadataWithRetryMock: vi.fn(),
  dispatchActivityNotificationAsyncMock: vi.fn(async () => ({
    attemptedChannels: 1,
    deliveredChannels: 1,
  })),
  getActiveAccountSettingsSnapshotMock: vi.fn(),
  resolveTranscriptRefreshBindingMock: vi.fn(),
  fetchAccountEncryptionCurrentnessMock: vi.fn(),
}));

vi.mock('@/api/session/external/secureRefresh/resolveExternalSessionTranscriptRefreshBinding', () => ({
  resolveExternalSessionTranscriptRefreshBinding: resolveTranscriptRefreshBindingMock,
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

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: fetchAccountEncryptionCurrentnessMock,
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
  readStoredCredentials: readCredentialsMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: fetchSessionByIdMock,
    commitSessionStoredMessage: commitSessionStoredMessageMock,
  };
});

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@/notifications/activity/dispatchActivityNotification', () => ({
  dispatchActivityNotificationAsync: dispatchActivityNotificationAsyncMock,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshotMock,
}));

import { registerMachineExternalSessionsRpcHandlers } from '../rpcHandlers.externalSessions';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function createClaudeLinkedSessionV1(input: Readonly<{
  configDir: string;
  projectId: string;
  remoteSessionId: string;
  linkedAtMs?: number;
  followPolicyV1?: Readonly<{
    v: 1;
    policy: 'background_follow';
    updatedAtMs: number;
  }>;
}>) {
  return {
    v: 1 as const,
    agentId: 'claude' as const,
    machineId: 'm1',
    remoteSessionId: input.remoteSessionId,
    source: {
      kind: 'claudeConfig' as const,
      configDir: input.configDir,
      projectId: input.projectId,
    },
    qualifiedIdentity: {
      v: 1 as const,
      agent: {
        pluginId: 'happier.agent.claude',
        localId: 'claude',
      },
      source: {
        kind: 'claudeConfig',
        contractVersion: 1 as const,
      },
    },
    linkData: {
      projectId: input.projectId,
    },
    linkedAtMs: input.linkedAtMs ?? 1_700_000_000_000,
    ...(input.followPolicyV1 ? { followPolicyV1: input.followPolicyV1 } : {}),
  };
}

async function waitForExpectation(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Expectation was not met before timeout');
}

describe('registerMachineExternalSessionsRpcHandlers', () => {
  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
    const externalSessionAgentIds = new Set(['claude', 'opencode']);
    const pluginIds = contributes.agents
      .filter((agent) => externalSessionAgentIds.has(agent.id))
      .map((agent) => agent.pluginId)
      .filter((pluginId): pluginId is string => typeof pluginId === 'string');
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir: '/tmp/happier-test-home',
        contributes,
        pluginIds,
        generationAuthority: {
          commit: null,
          generations: new Map(),
          rejectedGenerations: new Map(),
          unavailableBundledPackageNames: new Set(),
          isCurrent: async () => true,
        },
      }),
    });
    for (const agentId of externalSessionAgentIds) {
      const surfaces = await resolveBackendExecutionSurfaces(agentId);
      if (!surfaces.externalSession) {
        throw new Error(`Expected authoritative ${agentId} external-session execution surface`);
      }
    }
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resolveTranscriptRefreshBindingMock.mockImplementation(async ({ sessionId }) => ({
      v: 1,
      machineId: 'm1',
      sessionId,
      link: { generation: 'link-1', remoteSessionId: 'sess-push' },
      source: {
        qualifiedIdentity: {
          v: 1,
          agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 },
        },
        generation: 'source-1',
      },
      contributionGeneration: 'contribution-1',
      cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
    }));
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
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
      mode: 'plain',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
  });

  it('registers direct-session attach leases and detaches them', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-attach-')));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-attach', 'sess-attach.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-attach'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'happy-session-1',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-attach',
          remoteSessionId: 'sess-attach',
        }),
      }),
    });
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const attachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH);
    const detachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH);
    expect(attachHandler).toBeDefined();
    expect(detachHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-1',
      agentId: 'claude',
      remoteSessionId: 'sess-attach',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-attach' },
      ttlMs: 30_000,
    });

    expect(attached.ok).toBe(true);
    expect(typeof attached.leaseId).toBe('string');
    expect(attached.expiresAtMs).toBeGreaterThan(Date.now());

    const detached = await detachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-1',
      leaseId: attached.leaseId,
    });

    expect(detached).toEqual({ ok: true, detached: true });
  });

  it('writes lightweight background-follow policy metadata without transcript bodies', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-policy');
    const sessionFile = join(sessionDir, 'sess-claude-policy.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_policy',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy',
          remoteSessionId: 'sess-claude-policy',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy',
          remoteSessionId: 'sess-claude-policy',
        }),
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy',
      agentId: 'claude',
      remoteSessionId: 'sess-claude-policy',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
      enabled: true,
    });

    expect(res.ok).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.leaseActive).toBe(true);
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const metadataUpdateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const updatedMetadata = metadataUpdateArgs?.updater?.({
      path: '',
      machineId: 'm1',
      flavor: 'claude',
      externalSessionV1: createClaudeLinkedSessionV1({
        configDir,
        projectId: 'proj-policy',
        remoteSessionId: 'sess-claude-policy',
      }),
    });
    expect(updatedMetadata.externalSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: expect.any(Number),
    });
    expect(updatedMetadata.externalSessionV1.lastKnownActivityAtMs).toBeUndefined();
  });

  it('persists archived background-follow intent without acquiring live follow', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-archived-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-policy-archived');
    const sessionFile = join(sessionDir, 'sess-claude-policy-archived.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_policy_archived',
      archivedAt: 1_000,
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy-archived',
          remoteSessionId: 'sess-claude-policy-archived',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy-archived',
          remoteSessionId: 'sess-claude-policy-archived',
        }),
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;
    const installation = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    try {
      const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
      expect(handler).toBeDefined();

      const res = await handler!({
        machineId: 'm1',
        sessionId: 'sess_happy_policy_archived',
        agentId: 'claude',
        remoteSessionId: 'sess-claude-policy-archived',
        source: {
          kind: 'claudeConfig',
          configDir,
          projectId: 'proj-policy-archived',
        },
        enabled: true,
      });

      expect(res).toEqual(expect.objectContaining({
        ok: true,
        enabled: true,
        leaseActive: false,
      }));
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
      const metadataUpdateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
      const updatedMetadata = metadataUpdateArgs?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy-archived',
          remoteSessionId: 'sess-claude-policy-archived',
        }),
      });
      expect(updatedMetadata.externalSessionV1.followPolicyV1).toEqual({
        v: 1,
        policy: 'background_follow',
        updatedAtMs: expect.any(Number),
      });
      expect(commitSessionStoredMessageMock).not.toHaveBeenCalled();
    } finally {
      await installation.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an error and does not keep background follow enabled when follow-policy persistence fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-fail-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-policy-fail');
    const sessionFile = join(sessionDir, 'sess-claude-policy-fail.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_policy_fail',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy-fail',
          remoteSessionId: 'sess-claude-policy-fail',
        }),
      }),
    });
	    updateSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error('persist failed; token=abc123'));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy_fail',
      agentId: 'claude',
      remoteSessionId: 'sess-claude-policy-fail',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-fail' },
      enabled: true,
    });

	    expect(res.ok).toBe(false);
	    expect(res.errorCode).toBe('internal_error');
	    expect(res.error).toBe('follow_policy_persist_failed');
	    expect(res.error).not.toContain('token=abc123');
	  });

  it('returns an error without persisting follow policy when provider admission is unavailable', async () => {
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_opencode_policy',
      metadataVersion: 3,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'opencode',
        externalSessionV1: {
          v: 1,
          agentId: 'opencode',
          machineId: 'm1',
          remoteSessionId: 'remote-open',
          source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
          linkedAtMs: Date.now(),
        },
      }),
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_opencode_policy',
      agentId: 'opencode',
      remoteSessionId: 'remote-open',
      source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      enabled: true,
    });

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'agent_unavailable',
      retryable: true,
    }));
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('fails the follow-policy RPC when persisted metadata update fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-fail-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-policy-fail');
    const sessionFile = join(sessionDir, 'sess-claude-policy-fail.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_policy_fail',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-policy-fail',
          remoteSessionId: 'sess-claude-policy-fail',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockRejectedValueOnce(new Error('metadata write failed'));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy_fail',
      agentId: 'claude',
      remoteSessionId: 'sess-claude-policy-fail',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-fail' },
      enabled: true,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('internal_error');
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('persists lightweight progress markers for detached background-follow sessions when transcript updates arrive', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-background-follow-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-background');
    const sessionFile = join(sessionDir, 'sess-background.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_background',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background',
          remoteSessionId: 'sess-background',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background',
          remoteSessionId: 'sess-background',
        }),
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(policyHandler).toBeDefined();

    const res = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background',
      agentId: 'claude',
      remoteSessionId: 'sess-background',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
      enabled: true,
    });

    expect(res.ok).toBe(true);

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'background delta' }] } }),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalled();
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background',
          remoteSessionId: 'sess-background',
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        }),
      });
      expect(updated.externalSessionV1.followPolicyV1).toEqual(expect.objectContaining({
        policy: 'background_follow',
      }));
      expect(updated.externalSessionV1.lastKnownActivityAtMs).toEqual(expect.any(Number));
      expect(updated.externalSessionAttentionV1).toEqual(expect.objectContaining({
        observedProgressToken: expect.any(String),
        observedAtMs: expect.any(Number),
      }));
    });
  });

  it('persists lightweight progress markers after an attached viewer lease expires into background follow', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-background-expiry-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-background-expiry');
    const sessionFile = join(sessionDir, 'sess-background-expiry.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('HAPPIER_EXTERNAL_SESSIONS_ATTACH_LEASE_TTL_MS', '1000');
    vi.stubEnv('HAPPIER_CLAUDE_JSONL_SESSION_STORE_DETACHED_GRACE_MS', '250');

    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_background_expiry',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background-expiry',
          remoteSessionId: 'sess-background-expiry',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background-expiry',
          remoteSessionId: 'sess-background-expiry',
        }),
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const attachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH);
    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(attachHandler).toBeDefined();
    expect(policyHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      agentId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      ttlMs: 1_000,
    });
    expect(attached.ok).toBe(true);

    const policyResult = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      agentId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      enabled: true,
    });
    expect(policyResult.ok).toBe(true);
    const metadataCallCountBeforeExpiry = updateSessionMetadataWithRetryMock.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'post-expiry delta' }] } }),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock.mock.calls.length).toBeGreaterThan(metadataCallCountBeforeExpiry);
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background-expiry',
          remoteSessionId: 'sess-background-expiry',
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        }),
      });
      expect(updated.externalSessionAttentionV1).toEqual(expect.objectContaining({
        observedProgressToken: expect.any(String),
        observedAtMs: expect.any(Number),
      }));
    });
  });

  it('continues detached background-follow updates after an attached lease expires naturally', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-background-follow-expiry-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-background-expiry');
    const sessionFile = join(sessionDir, 'sess-background-expiry.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_background_expiry',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background-expiry',
          remoteSessionId: 'sess-background-expiry',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background-expiry',
          remoteSessionId: 'sess-background-expiry',
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        }),
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const attachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH);
    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    expect(attachHandler).toBeDefined();
    expect(policyHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      agentId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      ttlMs: 1_000,
    });
    expect(attached.ok).toBe(true);

    const policyResult = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      agentId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      enabled: true,
    });
    expect(policyResult).toEqual(expect.objectContaining({
      ok: true,
      enabled: true,
    }));

    updateSessionMetadataWithRetryMock.mockClear();

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'background expiry delta' }] } }),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalled();
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-background-expiry',
          remoteSessionId: 'sess-background-expiry',
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        }),
      });
      expect(updated.externalSessionV1.lastKnownActivityAtMs).toEqual(expect.any(Number));
      expect(updated.externalSessionAttentionV1).toEqual(expect.objectContaining({
        observedProgressToken: expect.any(String),
        observedAtMs: expect.any(Number),
      }));
    });
  });

  it('pushes content-free transcript invalidations for attached external sessions and stops after detach', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-push-')));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-push', 'sess-push.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-push'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'happy-session-push',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-push',
          remoteSessionId: 'sess-push',
        }),
      }),
    });
    const emitExternalSessionTranscriptUpdate = vi.fn(
      async (_payload: ExternalSessionTranscriptInvalidationV1) => {},
    );
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager,
      emitExternalSessionTranscriptUpdate,
    } as any);

    const attachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH);
    const detachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH);
    expect(attachHandler).toBeDefined();
    expect(detachHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-push',
      agentId: 'claude',
      remoteSessionId: 'sess-push',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-push' },
      ttlMs: 30_000,
      acceptedTailCursor: 'happier_external_cursor_v1:YzA',
    });

    expect(attached.ok).toBe(true);

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] } }),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        type: 'external-session-transcript-invalidated',
        binding: expect.objectContaining({ sessionId: 'happy-session-push' }),
      }));
      expect(emitExternalSessionTranscriptUpdate.mock.calls.at(-1)?.[0]).not.toHaveProperty('items');
    });

    emitExternalSessionTranscriptUpdate.mockClear();

    const detached = await detachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-push',
      leaseId: attached.leaseId,
    });

    expect(detached).toEqual({ ok: true, detached: true });

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a3', message: { model: 'm', content: [{ type: 'text', text: 'after detach' }] } }),
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(emitExternalSessionTranscriptUpdate).not.toHaveBeenCalled();
  });

  it('suppresses detached background-follow metadata writes and ready notifications while a viewer is attached', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-attached-suppression-')));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-attached-suppression');
    const sessionFile = join(sessionDir, 'sess-attached-suppression.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_attached_suppression',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-attached-suppression',
          remoteSessionId: 'sess-attached-suppression',
        }),
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: createClaudeLinkedSessionV1({
          configDir,
          projectId: 'proj-attached-suppression',
          remoteSessionId: 'sess-attached-suppression',
        }),
      }),
    }));

    const emitExternalSessionTranscriptUpdate = vi.fn(
      async (_payload: ExternalSessionTranscriptInvalidationV1) => {},
    );
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager,
      emitExternalSessionTranscriptUpdate,
    } as any);

    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET);
    const attachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH);
    expect(policyHandler).toBeDefined();
    expect(attachHandler).toBeDefined();

    const policyResult = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_attached_suppression',
      agentId: 'claude',
      remoteSessionId: 'sess-attached-suppression',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-attached-suppression' },
      enabled: true,
    });

    expect(policyResult).toEqual(expect.objectContaining({
      ok: true,
      enabled: true,
      leaseActive: true,
    }));

    updateSessionMetadataWithRetryMock.mockClear();
    dispatchActivityNotificationAsyncMock.mockClear();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_attached_suppression',
      agentId: 'claude',
      remoteSessionId: 'sess-attached-suppression',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-attached-suppression' },
      ttlMs: 30_000,
      acceptedTailCursor: 'happier_external_cursor_v1:YzA',
    });

    expect(attached).toEqual(expect.objectContaining({ ok: true }));

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'attached suppression delta' }] } }),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        type: 'external-session-transcript-invalidated',
        binding: expect.objectContaining({
          sessionId: 'sess_happy_attached_suppression',
        }),
      }));
      expect(emitExternalSessionTranscriptUpdate.mock.calls.at(-1)?.[0]).not.toHaveProperty('items');
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
  });

});
