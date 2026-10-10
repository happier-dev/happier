import { describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, createActionExecutor } from '@happier-dev/protocol';

const terminalPolicy = vi.hoisted(() => ({ value: 'allowed' as 'allowed' | 'disallowed' }));
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration,
    get terminalPresentUserPolicy() { return terminalPolicy.value; },
  } };
});

vi.mock('@/plugins/daemon/currentCatalog', () => ({
  readCurrentDaemonPluginCatalogSnapshot: vi.fn(async () => ({ plugins: [] })),
}));

import type { DaemonPatVerifier } from './auth/daemonPatVerifier';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
} from './externalActions/executeExternalAction';
import { createDaemonControlApp } from './controlServer';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

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
    externalActionApi: {
      ...externalActionApi,
      resolvePatExecutor: () => externalActionApi.executor,
    },
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
  it('refuses root approval decisions when terminal policy is disallowed and admits them when allowed', async () => {
    const app = createApp({
      currentServerId: 'server-local', verifyPat: vi.fn(), resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-local' }),
      executor: createActionExecutor(createCliActionDeps({
        token: 'test-token', sessionId: '', mode: 'plain', ctx: null,
      })),
    });
    try {
      const invoke = () => app.inject({ method: 'POST', url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: { actionId: 'approval.request.decide', input: { artifactId: 'missing', decision: 'approve' } },
      });
      terminalPolicy.value = 'disallowed';
      expect((await invoke()).json()).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      terminalPolicy.value = 'allowed';
      expect((await invoke()).json()).not.toHaveProperty('errorCode', 'present_user_required');
      const narrowed = await app.inject({ method: 'POST', url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token', 'x-happier-authority-ceiling': 'account_automation' },
        payload: { actionId: 'approval.request.decide', input: { artifactId: 'missing', decision: 'approve' } },
      });
      expect(narrowed.json()).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    } finally { terminalPolicy.value = 'allowed'; await app.close(); }
  });
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
    const pat = `hap_v1_11111111-1111-4111-8111-111111111111_${'A'.repeat(43)}`;
    const verifyPat = vi.fn<DaemonPatVerifier>(async () => ({
      ok: true as const,
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      grant: API_TOKEN_FULL_GRANT_V1,
      expiresAt: null,
      authority: 'account_automation' as const,
    }));
    const pending = {
      type: 'pending' as const,
      retryWithSameCreationKey: true,
      outcome: 'accepted' as const,
    };
    const execute = vi.fn(async () => ({ ok: true as const, result: pending }));
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
        headers: { authorization: `Bearer ${pat}` },
        payload: { v: 1, input: { directory: '/workspace' } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        v: 1,
        actionId: 'session.spawn_new',
        execution: { ok: true, result: pending },
      });
      expect(verifyPat).toHaveBeenCalledWith(pat, expect.any(AbortSignal));
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
          target: { kind: 'machine', machineId: 'machine-local' },
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

      // A request id with outer whitespace is rejected through the same
      // Protocol request-id schema the external envelope owns — never trimmed
      // into a different correlation identity.
      const paddedRequestIdResponse = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'machines.list',
          input: {},
          actionRequestId: ' padded ',
        },
      });

      expect(paddedRequestIdResponse.statusCode).toBe(400);
      expect(paddedRequestIdResponse.json()).toEqual({
        ok: false,
        errorCode: 'invalid_action_request',
        error: 'invalid_action_request',
      });
      expect(execute).not.toHaveBeenCalled();

      // Protocol-valid Unicode request ids pass through unchanged.
      const unicodeRequestIdResponse = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'machines.list',
          input: {},
          target: { kind: 'machine', machineId: 'machine-local' },
          actionRequestId: 'corrélation-☃',
        },
      });

      expect(unicodeRequestIdResponse.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledWith(
        'machines.list',
        {},
        expect.objectContaining({ actionRequestId: 'corrélation-☃' }),
      );

      const splitProjectTargetResponse = await app.inject({
        method: 'POST',
        url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: {
          actionId: 'workflow.run.start',
          input: {},
          target: { kind: 'machine', machineId: 'machine-local' },
          projectTarget: { machineId: 'machine-local', directory: '/repo' },
        },
      });
      expect(splitProjectTargetResponse.statusCode).toBe(400);
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
          target: { kind: 'machine', machineId: 'machine-local' },
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
          surface: 'cli',
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
          target: { kind: 'machine', machineId: 'machine-elsewhere' },
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
          target: { kind: 'machine', machineId: 'machine-local' },
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
