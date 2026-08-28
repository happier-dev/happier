import { describe, expect, it, vi } from 'vitest';

vi.mock('@/plugins/daemon/currentCatalog', () => ({
  readCurrentDaemonPluginCatalogSnapshot: vi.fn(async () => ({ plugins: [] })),
}));

import type { DaemonPatVerifier } from './auth/daemonPatVerifier';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
} from './externalActions/executeExternalAction';
import { createDaemonControlApp } from './controlServer';

type ExternalActionApi = Readonly<{
  currentServerId: string;
  verifyPat: DaemonPatVerifier;
  executor: ExternalActionExecutor;
  resolveTarget: ResolveExternalActionTarget;
}>;

function createApp(
  externalActionApi: ExternalActionApi,
  options: Readonly<{ enablePluginActionRoute?: boolean }> = {},
) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine-local',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'success' as const, sessionId: 'session-1' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'private-control-token',
    externalActionApi,
    ...(options.enablePluginActionRoute
      ? {
          pluginChangeService: {
            requestPluginChange: vi.fn(),
            decidePluginChange: vi.fn(),
            statusPluginChange: async () => ({ kind: 'expired' as const }),
            listPendingPluginChanges: async () => ({ changes: [] }),
            shutdown: async () => undefined,
          },
        }
      : {}),
  } as Parameters<typeof createDaemonControlApp>[0] & Readonly<{
    externalActionApi: ExternalActionApi;
  }>);
}

describe('createDaemonControlApp external Action ingress', () => {
  it('fails closed when a daemon-owned meta Action produces a non-JSON result', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(
      async () => ({ ok: true as const, result: 1n }),
    );
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat: vi.fn(),
      executor: { execute },
      resolveTarget: vi.fn(),
    }, { enablePluginActionRoute: true });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/plugins/actions/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'action.spec.search',
          input: { query: 'review' },
          surface: 'cli',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        matched: true,
        result: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'The Action returned a non-JSON result',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('mounts the PAT-only external Action route outside the private control-token guard', async () => {
    const verifyPat = vi.fn<DaemonPatVerifier>(async () => ({
      ok: true as const,
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      expiresAt: null,
      authority: 'account_automation' as const,
    }));
    const execute = vi.fn(async () => ({ ok: true as const, result: { accepted: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target, currentMachineId }) => (
      target ?? { kind: 'machine' as const, machineId: currentMachineId }
    ));
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat,
      executor: { execute },
      resolveTarget,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/actions/session.spawn_new',
        headers: { authorization: 'Bearer pat-secret' },
        payload: { v: 1, input: { directory: '/workspace' } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        v: 1,
        actionId: 'session.spawn_new',
        execution: { ok: true, result: { accepted: true } },
      });
      expect(verifyPat).toHaveBeenCalledWith('pat-secret', expect.any(AbortSignal));
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        'session.spawn_new',
        { directory: '/workspace' },
        expect.objectContaining({ serverId: 'server-local' }),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects caller-controlled signed-root context fields before execution', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { opened: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat: vi.fn(),
      executor: { execute },
      resolveTarget,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'session.open',
          input: { sessionId: 'session-from-input' },
          targetMachineId: 'machine-local',
          defaultSessionId: 'session-from-context',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'invalid_action_request',
        error: 'invalid_action_request',
      });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('host-stamps API present-user authority and canonical target placement', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(
      async () => ({ ok: true as const, result: { machines: [] } }),
    );
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat: vi.fn(),
      executor: { execute },
      resolveTarget,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'machines.list',
          input: { limit: 10 },
          targetMachineId: 'machine-local',
          actionRequestId: 'request-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, result: { machines: [] } });
      expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
        target: { kind: 'machine', machineId: 'machine-local' },
        currentMachineId: 'machine-local',
      }));
      expect(execute).toHaveBeenCalledWith(
        'machines.list',
        { limit: 10 },
        expect.objectContaining({
          surface: 'api',
          authority: 'present_user',
          actionCaller: { kind: 'host' },
          actionRequestId: 'request-1',
          externalActionTarget: { kind: 'machine', machineId: 'machine-local' },
          serverId: 'server-local',
        }),
      );
      expect(execute.mock.calls[0]?.[2]).not.toHaveProperty('externalActionCredential');
    } finally {
      await app.close();
    }
  });

  it('rejects an explicit signed-root machine that is not owned by this daemon', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { machines: [] } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(
      async ({ target, currentMachineId }) => (
        target?.kind === 'machine' && target.machineId === currentMachineId ? target : null
      ),
    );
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat: vi.fn(),
      executor: { execute },
      resolveTarget,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'machines.list',
          input: { limit: 10 },
          targetMachineId: 'machine-elsewhere',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'target_not_local',
        error: 'target_not_local',
      });
      expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
        target: { kind: 'machine', machineId: 'machine-elsewhere' },
        currentMachineId: 'machine-local',
      }));
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reuses canonical machine selector reconciliation for signed present-user execution', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { refreshed: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target, currentMachineId }) => (
      target ?? { kind: 'machine' as const, machineId: currentMachineId }
    ));
    const app = createApp({
      currentServerId: 'server-local',
      verifyPat: vi.fn(),
      executor: { execute },
      resolveTarget,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'memory.ensure_up_to_date',
          input: { machineId: 'machine-elsewhere' },
          targetMachineId: 'machine-local',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: false,
        errorCode: 'target_not_local',
        error: 'target_not_local',
      });
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
