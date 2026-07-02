import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { writeFakeCodexAppServerThreadListScript } from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

const {
  readCredentialsMock,
  fetchSessionByIdMock,
  commitSessionStoredMessageMock,
  updateSessionMetadataWithRetryMock,
  dispatchActivityNotificationAsyncMock,
  getActiveAccountSettingsSnapshotMock,
  createManagedExternalSessionFollowLeaseMock,
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
  createManagedExternalSessionFollowLeaseMock: vi.fn(),
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

vi.mock('@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease', async () => {
  const actual = await vi.importActual<typeof import('@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease')>(
    '@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease',
  );
  return {
    ...actual,
    createManagedExternalSessionFollowLease: async (
      ...args: Parameters<typeof actual.createManagedExternalSessionFollowLease>
    ) => {
      const forced = await createManagedExternalSessionFollowLeaseMock(...args);
      if (forced !== undefined) {
        return forced;
      }
      return actual.createManagedExternalSessionFollowLease(...args);
    },
  };
});

import { registerMachineExternalSessionsRpcHandlers } from '../rpcHandlers.externalSessions';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    createManagedExternalSessionFollowLeaseMock.mockReset();
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

  it('registers direct-session attach leases and detaches them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-attach-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-attach', 'sess-attach.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-attach'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

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
      providerId: 'claude',
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-'));
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
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_policy',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
          linkedAtMs: Date.now(),
        },
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy',
      providerId: 'claude',
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
      externalSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-claude-policy',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
        linkedAtMs: Date.now(),
      },
    });
    expect(updatedMetadata.externalSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: expect.any(Number),
    });
    expect(updatedMetadata.externalSessionV1.lastKnownActivityAtMs).toBeUndefined();
  });

  it('returns an error and does not keep background follow enabled when follow-policy persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-fail-'));
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
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_policy_fail',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy-fail',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-fail' },
          linkedAtMs: Date.now(),
        },
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

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy_fail',
      providerId: 'claude',
      remoteSessionId: 'sess-claude-policy-fail',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-fail' },
      enabled: true,
    });

	    expect(res.ok).toBe(false);
	    expect(res.errorCode).toBe('internal_error');
	    expect(res.error).toBe('follow_policy_persist_failed');
	    expect(res.error).not.toContain('token=abc123');
	  });

  it('returns an error without persisting follow policy when background follow lease acquisition fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-lease-fail-'));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-policy-lease-fail');
    const sessionFile = join(sessionDir, 'sess-claude-policy-lease-fail.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    createManagedExternalSessionFollowLeaseMock.mockRejectedValueOnce(new Error('lease failed'));

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_policy_lease_fail',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy-lease-fail',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-lease-fail' },
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

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy_lease_fail',
      providerId: 'claude',
      remoteSessionId: 'sess-claude-policy-lease-fail',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-lease-fail' },
      enabled: true,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('internal_error');
    expect(res.error).toBe('follow_policy_set_failed');
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('returns an error without persisting follow policy when the provider does not support background follow leases', async () => {
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_opencode_policy',
      metadataVersion: 3,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'opencode',
        externalSessionV1: {
          v: 1,
          providerId: 'opencode',
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

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_opencode_policy',
      providerId: 'opencode',
      remoteSessionId: 'remote-open',
      source: { kind: 'opencodeServer', directory: '/tmp/workspace' },
      enabled: true,
    });

    expect(res).toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'background_follow_not_supported',
    });
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('fails the follow-policy RPC when persisted metadata update fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-follow-policy-fail-'));
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
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_policy_fail',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy-fail',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-fail' },
          linkedAtMs: Date.now(),
        },
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

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy_fail',
      providerId: 'claude',
      remoteSessionId: 'sess-claude-policy-fail',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy-fail' },
      enabled: true,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('internal_error');
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('persists lightweight progress markers for detached background-follow sessions when transcript updates arrive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-background-follow-'));
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
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
          linkedAtMs: Date.now(),
        },
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(policyHandler).toBeDefined();

    const res = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background',
      providerId: 'claude',
      remoteSessionId: 'sess-background',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
      enabled: true,
    });

    expect(res.ok).toBe(true);

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'background delta' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalled();
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
          linkedAtMs: Date.now(),
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        },
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-background-expiry-'));
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
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background-expiry',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background-expiry',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
          linkedAtMs: Date.now(),
        },
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
    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(attachHandler).toBeDefined();
    expect(policyHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      providerId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      ttlMs: 1_000,
    });
    expect(attached.ok).toBe(true);

    const policyResult = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      providerId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      enabled: true,
    });
    expect(policyResult.ok).toBe(true);
    const metadataCallCountBeforeExpiry = updateSessionMetadataWithRetryMock.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'post-expiry delta' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock.mock.calls.length).toBeGreaterThan(metadataCallCountBeforeExpiry);
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background-expiry',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
          linkedAtMs: Date.now(),
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        },
      });
      expect(updated.externalSessionAttentionV1).toEqual(expect.objectContaining({
        observedProgressToken: expect.any(String),
        observedAtMs: expect.any(Number),
      }));
    });
  });

  it('continues detached background-follow updates after an attached lease expires naturally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-background-follow-expiry-'));
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
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background-expiry',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background-expiry',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
          linkedAtMs: Date.now(),
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        },
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
    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    expect(attachHandler).toBeDefined();
    expect(policyHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      providerId: 'claude',
      remoteSessionId: 'sess-background-expiry',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
      ttlMs: 1_000,
    });
    expect(attached.ok).toBe(true);

    const policyResult = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_expiry',
      providerId: 'claude',
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

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'background expiry delta' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalled();
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background-expiry',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-expiry' },
          linkedAtMs: Date.now(),
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        },
      });
      expect(updated.externalSessionV1.lastKnownActivityAtMs).toEqual(expect.any(Number));
      expect(updated.externalSessionAttentionV1).toEqual(expect.objectContaining({
        observedProgressToken: expect.any(String),
        observedAtMs: expect.any(Number),
      }));
    });
  });

  it('pushes transcript deltas for attached direct sessions and stops after detach', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-push-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-push', 'sess-push.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-push'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});
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
      providerId: 'claude',
      remoteSessionId: 'sess-push',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-push' },
      ttlMs: 30_000,
    });

    expect(attached.ok).toBe(true);

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        type: 'direct-session-transcript-delta',
        sessionId: 'happy-session-push',
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              content: expect.objectContaining({
                data: expect.objectContaining({
                  message: expect.objectContaining({
                    content: expect.arrayContaining([
                      expect.objectContaining({ text: 'hello from push' }),
                    ]),
                  }),
                }),
              }),
            }),
          }),
        ]),
        truncated: false,
      }));
    });

    emitExternalSessionTranscriptUpdate.mockClear();

    const detached = await detachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-push',
      leaseId: attached.leaseId,
    });

    expect(detached).toEqual({ ok: true, detached: true });

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] } }),
        jsonlLine({ type: 'assistant', uuid: 'a3', message: { model: 'm', content: [{ type: 'text', text: 'after detach' }] } }),
      ].join(''),
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(emitExternalSessionTranscriptUpdate).not.toHaveBeenCalled();
  });

  it('suppresses detached background-follow metadata writes and ready notifications while a viewer is attached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-attached-suppression-'));
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
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-attached-suppression',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-attached-suppression' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-attached-suppression',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-attached-suppression' },
          linkedAtMs: Date.now(),
        },
      }),
    }));

    const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});
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

    const policyHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_FOLLOW_POLICY_SET);
    const attachHandler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH);
    expect(policyHandler).toBeDefined();
    expect(attachHandler).toBeDefined();

    const policyResult = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_attached_suppression',
      providerId: 'claude',
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
      providerId: 'claude',
      remoteSessionId: 'sess-attached-suppression',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-attached-suppression' },
      ttlMs: 30_000,
    });

    expect(attached).toEqual(expect.objectContaining({ ok: true }));

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'attached suppression delta' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_happy_attached_suppression',
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              content: expect.objectContaining({
                data: expect.objectContaining({
                  message: expect.objectContaining({
                    content: expect.arrayContaining([
                      expect.objectContaining({ text: 'attached suppression delta' }),
                    ]),
                  }),
                }),
              }),
            }),
          }),
        ]),
      }));
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
  });

});
